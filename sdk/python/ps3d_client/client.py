"""Dependency-free PS3D MCP client for explicitly configured local stdio use.

The client never uses ``shell=True``, performs no network calls, discovers no
project files, and copies only a small runtime allowlist from the parent
environment. The caller must supply the complete command, working directory,
project objects, operations, receipts, and confirmation decision.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Mapping, Sequence
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
from typing import Any, Final, TextIO


JsonObject = dict[str, Any]
_END_OF_STREAM: Final = object()
_SAFE_ENVIRONMENT_KEYS: Final = frozenset(
    {
        "COMSPEC",
        "LANG",
        "LC_ALL",
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "WINDIR",
    }
)


class McpProtocolError(RuntimeError):
    """Raised when the local process violates or rejects the MCP exchange."""


class Ps3dClient:
    """Small synchronous dual-era MCP stdio client specialized for PS3D."""

    def __init__(
        self,
        command: Sequence[str],
        *,
        cwd: str | Path | None = None,
        timeout_seconds: float = 15.0,
        environment: Mapping[str, str] | None = None,
        protocol: str = "auto",
    ) -> None:
        if not command or any(not isinstance(part, str) or not part for part in command):
            raise ValueError("command must contain one or more non-empty argv strings")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if protocol not in {"auto", "modern", "legacy"}:
            raise ValueError("protocol must be 'auto', 'modern', or 'legacy'")
        self._command = tuple(command)
        self._cwd = None if cwd is None else Path(cwd)
        self._timeout_seconds = timeout_seconds
        self._environment = _safe_environment(environment)
        self._protocol_preference = protocol
        self._protocol_era: str | None = None
        self._protocol_version: str | None = None
        self._process: subprocess.Popen[str] | None = None
        self._stdout_messages: queue.Queue[object] = queue.Queue()
        self._stderr_tail: deque[str] = deque(maxlen=20)
        self._request_id = 0
        self._write_lock = threading.Lock()

    def __enter__(self) -> Ps3dClient:
        return self.start()

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()

    def start(self) -> Ps3dClient:
        """Start the configured command and negotiate modern or legacy MCP."""
        if self._process is not None:
            return self
        if self._protocol_preference == "legacy":
            self._launch()
            self._start_legacy()
            return self

        self._launch()
        try:
            discovered = self._request(
                "server/discover",
                {},
                protocol_version="2026-07-28",
            )
            supported = discovered.get("supportedVersions")
            if not isinstance(supported, list) or "2026-07-28" not in supported:
                raise McpProtocolError("server/discover did not advertise 2026-07-28")
        except McpProtocolError:
            self.close()
            if self._protocol_preference == "modern":
                raise
            self._launch()
            self._start_legacy()
            return self

        # The probe process is disposable. A clean second process is pinned to
        # the selected era by the metadata envelope on its first real request.
        self.close()
        self._launch()
        self._protocol_era = "modern"
        self._protocol_version = "2026-07-28"
        return self

    def _launch(self) -> None:
        """Launch one explicitly configured stdio process without a shell."""
        self._stdout_messages = queue.Queue()
        self._stderr_tail.clear()
        self._process = subprocess.Popen(
            list(self._command),
            cwd=None if self._cwd is None else str(self._cwd),
            env=self._environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="strict",
            bufsize=1,
            shell=False,
        )
        assert self._process.stdout is not None
        assert self._process.stderr is not None
        stdout_messages = self._stdout_messages
        threading.Thread(target=self._read_stdout, args=(self._process.stdout, stdout_messages), daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(self._process.stderr,), daemon=True).start()

    def _start_legacy(self) -> None:
        initialized = self._request(
            "initialize",
            {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "ps3d-python-client", "version": "0.2.0-preview.1"},
            },
        )
        negotiated = initialized.get("protocolVersion")
        if not isinstance(negotiated, str) or not negotiated.startswith("2025-"):
            raise McpProtocolError("initialize did not negotiate a supported 2025-era revision")
        self._notify("notifications/initialized", {})
        self._protocol_era = "legacy"
        self._protocol_version = negotiated

    def close(self) -> None:
        """Close protocol pipes and stop the configured local process."""
        process = self._process
        self._process = None
        self._protocol_era = None
        self._protocol_version = None
        if process is None:
            return
        if process.stdin is not None:
            process.stdin.close()
        try:
            process.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2.0)

    def list_tools(self) -> list[JsonObject]:
        """Return the tool records advertised by the configured MCP server."""
        result = self._request("tools/list", {})
        tools = result.get("tools")
        if not isinstance(tools, list) or not all(isinstance(tool, dict) for tool in tools):
            raise McpProtocolError("tools/list returned an invalid tools collection")
        return tools

    def protocol_info(self) -> JsonObject:
        """Return the selected local protocol era without making a server call."""
        if self._protocol_era is None or self._protocol_version is None:
            raise McpProtocolError("MCP client has not been started")
        return {"era": self._protocol_era, "version": self._protocol_version}

    def call_tool(self, name: str, arguments: Mapping[str, Any]) -> JsonObject:
        """Call a named MCP tool and return its complete MCP result object."""
        if not name:
            raise ValueError("tool name must not be empty")
        return self._request("tools/call", {"name": name, "arguments": dict(arguments)})

    def capabilities(self) -> JsonObject:
        return _structured(self.call_tool("ps3d_capabilities", {}))

    def guide(self) -> JsonObject:
        """Return PS3D's machine-readable AI collaboration contract."""
        return _structured(self.call_tool("ps3d_guide", {}))

    def guide_acknowledgement(self) -> JsonObject:
        """Read the current guide and build the required mutation acknowledgement."""
        guide = self.guide()
        digest = guide.get("manifestSha256")
        if not isinstance(digest, str) or len(digest) != 64:
            raise McpProtocolError("ps3d_guide returned no valid manifestSha256")
        return {"manifestSha256": digest, "understood": True}

    def agent_handshake(
        self,
        request: str,
        experience_level: str,
        *,
        workspace: str | None = None,
        client_name: str | None = None,
        project_revision: int | None = None,
        proposed_tool: str | None = None,
        proposed_recipe_id: str | None = None,
    ) -> JsonObject:
        """Configure one stateless host-AI/PS3D coordination and correction pass."""
        arguments: JsonObject = {
            "request": request,
            "experienceLevel": experience_level,
        }
        optional = {
            "workspace": workspace,
            "clientName": client_name,
            "projectRevision": project_revision,
            "proposedTool": proposed_tool,
            "proposedRecipeId": proposed_recipe_id,
        }
        arguments.update({key: value for key, value in optional.items() if value is not None})
        return _structured(self.call_tool("ps3d_agent_handshake", arguments))

    def find_commands(
        self,
        query: str,
        *,
        workspace: str | None = None,
        limit: int = 6,
    ) -> JsonObject:
        """Find bounded command recipes; this lookup never executes them."""
        arguments: JsonObject = {"query": query, "limit": limit}
        if workspace is not None:
            arguments["workspace"] = workspace
        return _structured(self.call_tool("ps3d_find_commands", arguments))

    def plan_engineering_intent(
        self,
        request: str,
        *,
        unit: str = "mm",
        workspace: str | None = None,
        experience_level: str | None = None,
        project_revision: int | None = None,
        target_cad: Sequence[str] | None = None,
        evidence: Sequence[str] | None = None,
    ) -> JsonObject:
        """Compile ordinary part/assembly intent into a read-only engineering plan."""
        arguments: JsonObject = {"request": request, "unit": unit}
        optional = {
            "workspace": workspace,
            "experienceLevel": experience_level,
            "projectRevision": project_revision,
        }
        arguments.update({key: value for key, value in optional.items() if value is not None})
        if target_cad is not None:
            arguments["targetCad"] = list(target_cad)
        if evidence is not None:
            arguments["evidence"] = list(evidence)
        return _structured(self.call_tool("ps3d_plan_engineering_intent", arguments))

    def inspect(self, project: Mapping[str, Any]) -> JsonObject:
        return _structured(self.call_tool("ps3d_inspect_project", {"project": dict(project)}))

    def design_health(self, project: Mapping[str, Any]) -> JsonObject:
        """Analyze all workspaces, dependencies, rebuild order, and readiness."""
        return _structured(self.call_tool("ps3d_design_health", {"project": dict(project)}))

    def analyze_vehicle(self, project: Mapping[str, Any]) -> JsonObject:
        """Return PS3D's read-only preliminary vehicle analysis for a project."""
        return _structured(
            self.call_tool("ps3d_analyze_vehicle", {"project": dict(project)})
        )

    def electromechanical_catalog(self) -> JsonObject:
        return _structured(self.call_tool("ps3d_electromechanical_catalog", {}))

    def preview_electromechanical(
        self,
        project: Mapping[str, Any],
        guide_acknowledgement: Mapping[str, Any],
    ) -> JsonObject:
        return _structured(
            self.call_tool(
                "ps3d_preview_electromechanical",
                {
                    "project": dict(project),
                    "guideAcknowledgement": dict(guide_acknowledgement),
                },
            )
        )

    def preview(
        self,
        project: Mapping[str, Any],
        operation: Mapping[str, Any],
        guide_acknowledgement: Mapping[str, Any],
    ) -> JsonObject:
        return _structured(
            self.call_tool(
                "ps3d_preview_operation",
                {
                    "project": dict(project),
                    "operation": dict(operation),
                    "guideAcknowledgement": dict(guide_acknowledgement),
                },
            )
        )

    def apply(
        self,
        project: Mapping[str, Any],
        operation: Mapping[str, Any],
        receipt: str,
        *,
        confirmed: bool,
        guide_acknowledgement: Mapping[str, Any],
    ) -> JsonObject:
        if confirmed is not True:
            raise ValueError("confirmed=True is required to call ps3d_apply_preview")
        return _structured(
            self.call_tool(
                "ps3d_apply_preview",
                {
                    "project": dict(project),
                    "operation": dict(operation),
                    "receipt": receipt,
                    "confirmed": True,
                    "guideAcknowledgement": dict(guide_acknowledgement),
                },
            )
        )

    def _request(
        self,
        method: str,
        params: Mapping[str, Any],
        *,
        protocol_version: str | None = None,
    ) -> JsonObject:
        self._request_id += 1
        request_id = self._request_id
        wire_params = dict(params)
        selected_version = protocol_version
        if selected_version is None and self._protocol_era == "modern":
            selected_version = self._protocol_version
        if selected_version is not None:
            wire_params["_meta"] = {
                "io.modelcontextprotocol/protocolVersion": selected_version,
                "io.modelcontextprotocol/clientInfo": {
                    "name": "ps3d-python-client",
                    "version": "0.2.0-preview.1",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
            }
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": wire_params})
        deadline = time.monotonic() + self._timeout_seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise McpProtocolError(f"MCP request timed out: {method}{self._diagnostic_suffix()}")
            try:
                item = self._stdout_messages.get(timeout=remaining)
            except queue.Empty as error:
                raise McpProtocolError(f"MCP request timed out: {method}{self._diagnostic_suffix()}") from error
            if item is _END_OF_STREAM:
                raise McpProtocolError(f"MCP process closed stdout during {method}{self._diagnostic_suffix()}")
            if isinstance(item, McpProtocolError):
                raise item
            if not isinstance(item, dict) or item.get("id") != request_id:
                continue
            if "error" in item:
                raise McpProtocolError(f"MCP error during {method}: {item['error']!r}{self._diagnostic_suffix()}")
            result = item.get("result")
            if not isinstance(result, dict):
                raise McpProtocolError(f"MCP response to {method} has no result object")
            return result

    def _notify(self, method: str, params: Mapping[str, Any]) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": dict(params)})

    def _send(self, payload: Mapping[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None or process.poll() is not None:
            raise McpProtocolError(f"MCP process is not running{self._diagnostic_suffix()}")
        line = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        with self._write_lock:
            process.stdin.write(line + "\n")
            process.stdin.flush()

    def _read_stdout(self, stream: TextIO, messages: queue.Queue[object]) -> None:
        try:
            for line in stream:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    message = json.loads(stripped)
                except json.JSONDecodeError as error:
                    messages.put(McpProtocolError(f"MCP stdout contained invalid JSON: {error}"))
                    continue
                if not isinstance(message, dict):
                    messages.put(McpProtocolError("MCP stdout message must be a JSON object"))
                    continue
                messages.put(message)
        finally:
            messages.put(_END_OF_STREAM)

    def _read_stderr(self, stream: TextIO) -> None:
        for line in stream:
            stripped = line.strip()
            if stripped:
                self._stderr_tail.append(stripped)

    def _diagnostic_suffix(self) -> str:
        return "" if not self._stderr_tail else f"; stderr: {' | '.join(self._stderr_tail)}"


def _structured(result: Mapping[str, Any]) -> JsonObject:
    if result.get("isError") is True:
        raise McpProtocolError(f"PS3D tool returned an error: {result.get('content')!r}")
    structured = result.get("structuredContent")
    if not isinstance(structured, dict):
        raise McpProtocolError("PS3D tool result has no structuredContent object")
    return structured


def _safe_environment(source: Mapping[str, str] | None = None) -> dict[str, str]:
    values = os.environ if source is None else source
    return {
        key: value
        for key, value in values.items()
        if key.upper() in _SAFE_ENVIRONMENT_KEYS
    }
