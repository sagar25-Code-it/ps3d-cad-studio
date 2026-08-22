const forbiddenModule =
  /(?:^|[/\\])solid-manifold-adapter(?:[/\\]|$)|(?:^|[/\\])manifold-3d(?:[/\\]|$)|(?:^|[/\\])@modelcontextprotocol[/\\](?:core|server)(?:[/\\]|$)|(?:^|[/\\])zod(?:[/\\]|$)|(?:^|[/\\])apps[/\\]mcp-server(?:[/\\]|$)/iu;

export function assertProductionModuleAllowed(specifier) {
  if (forbiddenModule.test(specifier)) {
    throw new Error(`Production browser graph reached a development-only or Node-only module: ${specifier}`);
  }
}

export function productionGeometryBoundaryPlugin() {
  return {
    name: "ps3d-production-geometry-boundary",
    enforce: "pre",
    resolveId(source, importer) {
      assertProductionModuleAllowed(source);
      if (importer !== undefined) assertProductionModuleAllowed(importer);
      return null;
    },
    load(id) {
      assertProductionModuleAllowed(id);
      return null;
    }
  };
}
