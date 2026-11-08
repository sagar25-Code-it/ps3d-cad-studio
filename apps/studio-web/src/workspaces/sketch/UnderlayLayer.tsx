import { useEffect, useState } from "react";
import type { SketchUnderlay } from "../../../../../packages/workbench-core/src/index.js";
import { browserImageStore } from "../../underlay-store.js";

/**
 * The locked picture behind a sketch. It is drawn in the sketch's own coordinates (the canvas flips Y), takes no pointer input, and
 * shows nothing until the pixels are found in this browser's image store.
 */
export function UnderlayLayer({ underlay, onMissing }: { readonly underlay: SketchUnderlay; readonly onMissing?: (missing: boolean) => void }): React.JSX.Element | null {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const imageId = underlay.imageId;
  useEffect(() => {
    let alive = true;
    let objectUrl: string | undefined;
    void browserImageStore.get(imageId).then((stored) => {
      if (!alive) return;
      if (stored === undefined) { setUrl(undefined); onMissing?.(true); return; }
      objectUrl = URL.createObjectURL(new Blob([stored.bytes as BlobPart], { type: stored.mime }));
      setUrl(objectUrl);
      onMissing?.(false);
    });
    return () => {
      alive = false;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [imageId]);
  if (!underlay.visible || url === undefined) return null;
  const width = underlay.widthPx * underlay.mmPerPixel;
  const height = underlay.heightPx * underlay.mmPerPixel;
  // Local frame: origin at the picture's lower left corner, x to the right, y down on screen; the picture extends upward.
  return <g className="sketch-underlay" pointerEvents="none" data-underlay={underlay.imageId} transform={`translate(${underlay.originMm[0]} ${-underlay.originMm[1]}) rotate(${-underlay.rotationDeg})`} opacity={underlay.opacity}>
    <image href={url} x={0} y={-height} width={width} height={height} preserveAspectRatio="none" />
  </g>;
}
