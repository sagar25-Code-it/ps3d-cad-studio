/** Small closed meshes for the analysis tests. Not a test file. */

export interface TestMesh {
  positionsMm: number[];
  indices: number[];
}

/** Axis-aligned box with outward counter-clockwise triangles (12 triangles, 8 vertices). */
export function boxMeshAt(min: readonly [number, number, number], max: readonly [number, number, number]): TestMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    positionsMm: [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
    indices: [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]
  };
}

/** The same box with separate vertices per face (24 vertices), as renderers usually carry it. */
export function unweldedBox(min: readonly [number, number, number], max: readonly [number, number, number]): TestMesh {
  const welded = boxMeshAt(min, max);
  const positionsMm: number[] = [];
  const indices: number[] = [];
  for (const index of welded.indices) {
    indices.push(positionsMm.length / 3);
    positionsMm.push(welded.positionsMm[index * 3]!, welded.positionsMm[index * 3 + 1]!, welded.positionsMm[index * 3 + 2]!);
  }
  // Share the six corners of each quad so that only the faces differ: 4 vertices per face.
  const merged: number[] = [];
  const out: number[] = [];
  const seen = new Map<string, number>();
  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    const face = Math.floor(triangle / 2);
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[triangle * 3 + corner]!;
      const key = `${face}|${positionsMm[vertex * 3]}|${positionsMm[vertex * 3 + 1]}|${positionsMm[vertex * 3 + 2]}`;
      let id = seen.get(key);
      if (id === undefined) { id = merged.length / 3; merged.push(positionsMm[vertex * 3]!, positionsMm[vertex * 3 + 1]!, positionsMm[vertex * 3 + 2]!); seen.set(key, id); }
      out.push(id);
    }
  }
  return { positionsMm: merged, indices: out };
}

/** A hollow box: the outer box plus an inner box with reversed faces, so the wall is `wall` thick everywhere. */
export function hollowBox(size: number, wall: number): TestMesh {
  const outer = boxMeshAt([0, 0, 0], [size, size, size]);
  const inner = boxMeshAt([wall, wall, wall], [size - wall, size - wall, size - wall]);
  const base = outer.positionsMm.length / 3;
  const flipped: number[] = [];
  for (let corner = 0; corner < inner.indices.length; corner += 3) flipped.push(inner.indices[corner]! + base, inner.indices[corner + 2]! + base, inner.indices[corner + 1]! + base);
  return { positionsMm: [...outer.positionsMm, ...inner.positionsMm], indices: [...outer.indices, ...flipped] };
}

export function concatMeshes(first: TestMesh, second: TestMesh): TestMesh {
  const base = first.positionsMm.length / 3;
  return { positionsMm: [...first.positionsMm, ...second.positionsMm], indices: [...first.indices, ...second.indices.map((index) => index + base)] };
}

/** A geodesic sphere (icosahedron subdivided `levels` times) of the given radius, centred on `centre`. */
export function icosphere(radius: number, levels: number, centre: readonly [number, number, number] = [0, 0, 0]): TestMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: [number, number, number][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  const points = raw.map((point) => { const l = Math.hypot(...point); return [point[0] / l, point[1] / l, point[2] / l] as [number, number, number]; });
  let faces: [number, number, number][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let level = 0; level < levels; level += 1) {
    const cache = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      let id = cache.get(key);
      if (id === undefined) {
        const p = points[a]!; const q = points[b]!;
        const m: [number, number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
        const l = Math.hypot(...m);
        points.push([m[0] / l, m[1] / l, m[2] / l]);
        id = points.length - 1;
        cache.set(key, id);
      }
      return id;
    };
    const next: [number, number, number][] = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b); const bc = midpoint(b, c); const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return {
    positionsMm: points.flatMap((p) => [p[0] * radius + centre[0], p[1] * radius + centre[1], p[2] * radius + centre[2]]),
    indices: faces.flat()
  };
}

/** A square frustum standing on z = 0 whose four side faces lean inward by `draftDeg` (a mould-style draft). */
export function draftedBlock(bottomSize: number, height: number, draftDeg: number): TestMesh {
  const shrink = height * Math.tan(draftDeg * Math.PI / 180);
  const b = bottomSize / 2;
  const t = b - shrink;
  return {
    positionsMm: [-b, -b, 0, b, -b, 0, b, b, 0, -b, b, 0, -t, -t, height, t, -t, height, t, t, height, -t, t, height],
    indices: [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]
  };
}

export function flipWinding(mesh: TestMesh): TestMesh {
  const indices: number[] = [];
  for (let corner = 0; corner < mesh.indices.length; corner += 3) indices.push(mesh.indices[corner]!, mesh.indices[corner + 2]!, mesh.indices[corner + 1]!);
  return { positionsMm: mesh.positionsMm, indices };
}
