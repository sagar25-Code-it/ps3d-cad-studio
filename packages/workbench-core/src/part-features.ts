import type {
  PartBodyEdgeTreatment,
  PartBodyFaceId,
  PartPreviewBody,
  Vec3
} from "./types.js";

const EPSILON = 1e-7;
const MIN_WALL_MM = 0.5;

export type PartFeatureResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly relatedIds: readonly string[]; readonly recovery: string };

export function createRevolvedPartBody(input: {
  readonly operationId: string;
  readonly bodyId: string;
  readonly name: string;
  readonly outerDiameterMm: number;
  readonly innerDiameterMm: number;
  readonly heightMm: number;
  readonly angleDeg: number;
  readonly translationMm: Vec3;
}): PartFeatureResult<PartPreviewBody> {
  if (input.innerDiameterMm <= 0 || input.outerDiameterMm <= input.innerDiameterMm + MIN_WALL_MM * 2) {
    return unsupported("The revolved rectangular profile needs a positive inner diameter and at least a 0.5 mm radial wall.", [input.bodyId], "Increase the outer diameter or reduce the inner diameter.");
  }
  if (input.heightMm <= 0 || input.angleDeg <= 0 || input.angleDeg > 360) {
    return unsupported("The revolve height or sweep angle is outside the supported analytic envelope.", [input.bodyId], "Use a positive height and an angle from 0 to 360 degrees.");
  }
  return success({
    id: input.bodyId,
    name: input.name,
    shape: "revolved",
    visible: true,
    color: "#aeb3b8",
    translationMm: input.translationMm,
    rotationDeg: [0, 0, 0],
    sizeMm: [input.outerDiameterMm, input.innerDiameterMm, input.heightMm],
    revolveAngleDeg: input.angleDeg,
    featureTrace: { kind: "revolve", operationId: input.operationId, parentIds: ["sketch:primary-profile"] }
  });
}

export function patternPartBody(input: {
  readonly operationId: string;
  readonly body: PartPreviewBody;
  readonly instanceIds: readonly string[];
  readonly direction: "x" | "y" | "z";
  readonly spacingMm: number;
}): PartFeatureResult<readonly PartPreviewBody[]> {
  if (input.instanceIds.length < 1 || input.instanceIds.length > 23 || input.spacingMm <= 0) {
    return unsupported("The bounded feature pattern needs 2 to 24 total instances and positive spacing.", [input.body.id], "Supply 1 to 23 new instance IDs and a positive spacing in millimetres.");
  }
  const axis = input.direction === "x" ? 0 : input.direction === "y" ? 1 : 2;
  return success(input.instanceIds.map((id, index): PartPreviewBody => {
    const translation = [...input.body.translationMm] as [number, number, number];
    translation[axis] += input.spacingMm * (index + 1);
    return {
      ...input.body,
      id,
      name: `${input.body.name} · Pattern ${index + 2}`,
      translationMm: translation,
      featureTrace: { kind: "pattern", operationId: input.operationId, parentIds: [input.body.id] }
    };
  }));
}

export function mirrorPartBody(input: {
  readonly operationId: string;
  readonly body: PartPreviewBody;
  readonly newBodyId: string;
  readonly plane: "xy" | "xz" | "yz";
}): PartFeatureResult<PartPreviewBody> {
  const [x, y, z] = input.body.translationMm;
  const [rx, ry, rz] = input.body.rotationDeg;
  const transform = input.plane === "yz"
    ? { translationMm: [-x, y, z] as Vec3, rotationDeg: [rx, -ry, -rz] as Vec3 }
    : input.plane === "xz"
      ? { translationMm: [x, -y, z] as Vec3, rotationDeg: [-rx, ry, -rz] as Vec3 }
      : { translationMm: [x, y, -z] as Vec3, rotationDeg: [-rx, -ry, rz] as Vec3 };
  return success({
    ...input.body,
    id: input.newBodyId,
    name: `${input.body.name} · Mirror ${input.plane.toUpperCase()}`,
    ...transform,
    featureTrace: { kind: "mirror", operationId: input.operationId, parentIds: [input.body.id] }
  });
}

export function booleanPartBodies(input: {
  readonly operationId: string;
  readonly target: PartPreviewBody;
  readonly tool: PartPreviewBody;
  readonly operation: "unite" | "subtract";
}): PartFeatureResult<PartPreviewBody> {
  if (!axisAligned(input.target) || !axisAligned(input.tool) || hasShapeModifiers(input.tool)) {
    return unsupported("This bounded Boolean requires unrotated analytic operands and an unmodified tool body.", [input.target.id, input.tool.id], "Set both rotations to 0° and use a plain block or cylinder tool.");
  }
  return input.operation === "unite" ? uniteBodies(input) : subtractBodies(input);
}

export function trimPartBody(input: {
  readonly operationId: string;
  readonly body: PartPreviewBody;
  readonly keptLengthMm: number;
  readonly side: "negative" | "positive";
}): PartFeatureResult<PartPreviewBody> {
  if (input.body.shape === "sphere" || input.keptLengthMm <= 0 || input.keptLengthMm >= input.body.sizeMm[2]) {
    return unsupported("Trim Body supports a non-spherical analytic body and must remove a positive portion of its local Z length.", [input.body.id], "Choose a kept length greater than 0 and smaller than the current body height.");
  }
  if (input.body.shellThicknessMm !== undefined || input.body.edgeTreatment !== undefined || input.body.draftAngleDeg !== undefined) {
    return unsupported("Trim Body currently requires a plain or through-bored analytic body.", [input.body.id], "Delete the shell, draft, or edge treatment before trimming this body.");
  }
  const shift = (input.body.sizeMm[2] - input.keptLengthMm) / 2 * (input.side === "positive" ? 1 : -1);
  return success({
    ...input.body,
    sizeMm: [input.body.sizeMm[0], input.body.sizeMm[1], input.keptLengthMm],
    translationMm: add(input.body.translationMm, rotateLocalVector([0, 0, shift], input.body.rotationDeg)),
    featureTrace: { kind: "trim", operationId: input.operationId, parentIds: [input.body.id] }
  });
}

export function setPartBodyEdgeTreatment(input: {
  readonly operationId: string;
  readonly body: PartPreviewBody;
  readonly treatment: PartBodyEdgeTreatment;
  readonly sizeMm: number;
}): PartFeatureResult<PartPreviewBody> {
  if (input.body.shape !== "block" || input.body.boreDiameterMm !== undefined || input.body.shellThicknessMm !== undefined || input.body.draftAngleDeg !== undefined) {
    return unsupported("Edge Blend and Chamfer currently support a plain analytic block with its four vertical edges selected.", [input.body.id], "Select an unmodified block or heal its bore, shell, or draft first.");
  }
  const maximum = Math.min(input.body.sizeMm[0], input.body.sizeMm[1]) / 2 - MIN_WALL_MM;
  if (input.sizeMm <= 0 || input.sizeMm > maximum) {
    return unsupported(`The requested ${input.treatment} size exceeds the block's supported edge envelope.`, [input.body.id], `Use a value greater than 0 and no more than ${round(maximum)} mm.`);
  }
  return success({
    ...input.body,
    edgeTreatment: { kind: input.treatment, sizeMm: input.sizeMm },
    featureTrace: { kind: "edge-treatment", operationId: input.operationId, parentIds: [input.body.id] }
  });
}

export function setPartBodyDraft(input: { readonly operationId: string; readonly body: PartPreviewBody; readonly angleDeg: number }): PartFeatureResult<PartPreviewBody> {
  if (!(["block", "cylinder"] as const).includes(input.body.shape as "block" | "cylinder") || hasShapeModifiers(input.body)) {
    return unsupported("Draft Body currently supports a plain analytic block or cylinder with local Z as the pull direction.", [input.body.id], "Select an unmodified block or cylinder and keep its local Z axis as the pull direction.");
  }
  const shrink = 2 * input.body.sizeMm[2] * Math.tan(input.angleDeg * Math.PI / 180);
  if (input.angleDeg <= 0 || input.angleDeg > 20 || shrink >= Math.min(input.body.sizeMm[0], input.body.sizeMm[1]) - MIN_WALL_MM * 2) {
    return unsupported("The draft would collapse the lower profile or exceeds the supported 20° limit.", [input.body.id], "Use a smaller positive draft angle or enlarge the body cross-section.");
  }
  return success({
    ...input.body,
    draftAngleDeg: input.angleDeg,
    featureTrace: { kind: "draft", operationId: input.operationId, parentIds: [input.body.id] }
  });
}

export function setPartBodyShell(input: { readonly operationId: string; readonly body: PartPreviewBody; readonly thicknessMm: number }): PartFeatureResult<PartPreviewBody> {
  if (!(["block", "cylinder"] as const).includes(input.body.shape as "block" | "cylinder") || hasShapeModifiers(input.body)) {
    return unsupported("Shell currently supports a plain analytic block or cylinder and removes its local +Z face.", [input.body.id], "Select an unmodified block or cylinder.");
  }
  const maximum = Math.min(input.body.sizeMm[0] / 2, input.body.sizeMm[1] / 2, input.body.sizeMm[2]) - MIN_WALL_MM;
  if (input.thicknessMm <= 0 || input.thicknessMm > maximum) {
    return unsupported("The shell thickness would consume the cavity or bottom wall.", [input.body.id], `Use a wall thickness greater than 0 and no more than ${round(maximum)} mm.`);
  }
  return success({
    ...input.body,
    shellThicknessMm: input.thicknessMm,
    featureTrace: { kind: "shell", operationId: input.operationId, parentIds: [input.body.id] }
  });
}

export function movePartBodyFace(input: {
  readonly operationId: string;
  readonly body: PartPreviewBody;
  readonly face: PartBodyFaceId;
  readonly offsetMm: number;
}): PartFeatureResult<PartPreviewBody> {
  if (input.body.shellThicknessMm !== undefined || input.body.edgeTreatment !== undefined || input.body.draftAngleDeg !== undefined) {
    return unsupported("Move/Offset Face currently requires a plain or through-bored analytic body.", [input.body.id], "Heal the shell, edge treatment, or draft before editing this face.");
  }
  const axis = faceAxis(input.face);
  if (input.body.shape !== "block" && axis !== 2) {
    return unsupported("Non-block analytic bodies currently expose only their planar local ±Z faces for direct editing.", [input.body.id], "Select a local Z face or use a block for X/Y face editing.");
  }
  const size = [...input.body.sizeMm] as [number, number, number];
  size[axis] += input.offsetMm;
  if (size[axis] <= MIN_WALL_MM || !boreFits(input.body, size)) {
    return unsupported("The face edit would collapse the body or violate the 0.5 mm bore wall.", [input.body.id], "Reduce the inward offset or heal/reduce the bore first.");
  }
  const sign = input.face.endsWith("positive") ? 1 : -1;
  const localShift = [0, 0, 0] as [number, number, number];
  localShift[axis] = sign * input.offsetMm / 2;
  return success({
    ...input.body,
    sizeMm: size,
    translationMm: add(input.body.translationMm, rotateLocalVector(localShift, input.body.rotationDeg)),
    featureTrace: { kind: "face-edit", operationId: input.operationId, parentIds: [input.body.id] }
  });
}

export function replacePartBodyFace(input: {
  readonly operationId: string;
  readonly body: PartPreviewBody;
  readonly face: PartBodyFaceId;
  readonly localPositionMm: number;
}): PartFeatureResult<PartPreviewBody> {
  const axis = faceAxis(input.face);
  const sign = input.face.endsWith("positive") ? 1 : -1;
  const current = sign * input.body.sizeMm[axis] / 2;
  const outwardOffset = sign * (input.localPositionMm - current);
  return movePartBodyFace({ ...input, offsetMm: outwardOffset });
}

export function deletePartBodyFaceFeature(input: {
  readonly operationId: string;
  readonly body: PartPreviewBody;
  readonly feature: "bore" | "edge-treatment" | "shell" | "draft";
}): PartFeatureResult<PartPreviewBody> {
  const present = input.feature === "bore" ? input.body.boreDiameterMm !== undefined
    : input.feature === "edge-treatment" ? input.body.edgeTreatment !== undefined
      : input.feature === "shell" ? input.body.shellThicknessMm !== undefined
        : input.body.draftAngleDeg !== undefined;
  if (!present) return unsupported(`The selected body has no recognized ${input.feature} face set to delete and heal.`, [input.body.id], "Select a body containing that recognized analytic feature.");
  const healed: PartPreviewBody = { ...input.body, featureTrace: { kind: "heal", operationId: input.operationId, parentIds: [input.body.id] } };
  if (input.feature === "bore") deleteMutable(healed, "boreDiameterMm");
  if (input.feature === "edge-treatment") deleteMutable(healed, "edgeTreatment");
  if (input.feature === "shell") deleteMutable(healed, "shellThicknessMm");
  if (input.feature === "draft") deleteMutable(healed, "draftAngleDeg");
  return success(healed);
}

export function validatePartFeatureStack(body: PartPreviewBody): PartFeatureResult<PartPreviewBody> {
  if (body.shape === "revolved") {
    if (body.revolveAngleDeg === undefined || body.revolveAngleDeg <= 0 || body.revolveAngleDeg > 360 || body.sizeMm[1] <= 0 || body.sizeMm[1] >= body.sizeMm[0]) {
      return unsupported("A revolved body has an invalid annular profile or sweep angle.", [body.id], "Repair its inner diameter, outer diameter, height, and angle.");
    }
  }
  const modifierCount = Number(body.boreDiameterMm !== undefined) + Number(body.edgeTreatment !== undefined) + Number(body.shellThicknessMm !== undefined) + Number(body.draftAngleDeg !== undefined);
  if (modifierCount > 1) return unsupported("This body contains an unsupported modifier stack.", [body.id], "Keep only one bounded bore, edge, shell, or draft modifier on a preview body.");
  if (!boreFits(body, body.sizeMm)) return unsupported("The analytic bore violates the minimum wall allowance.", [body.id], "Reduce the bore diameter or enlarge the body.");
  return success(body);
}

function uniteBodies(input: { readonly operationId: string; readonly target: PartPreviewBody; readonly tool: PartPreviewBody }): PartFeatureResult<PartPreviewBody> {
  if (hasShapeModifiers(input.target)) return unsupported("Unite requires a plain target body in the bounded analytic evaluator.", [input.target.id], "Heal or remove target modifiers before Unite.");
  if (input.target.shape === "block" && input.tool.shape === "block") {
    const left = bodyIntervals(input.target);
    const right = bodyIntervals(input.tool);
    for (let axis = 0; axis < 3; axis += 1) {
      const secondary = [0, 1, 2].filter((candidate) => candidate !== axis);
      if (secondary.every((candidate) => sameInterval(left[candidate]!, right[candidate]!)) && intervalsTouch(left[axis]!, right[axis]!)) {
        const bounds = [0, 1, 2].map((candidate) => [Math.min(left[candidate]![0], right[candidate]![0]), Math.max(left[candidate]![1], right[candidate]![1])] as const);
        return success(withBooleanTrace(input, {
          ...input.target,
          translationMm: bounds.map(([minimum, maximum]) => (minimum + maximum) / 2) as unknown as Vec3,
          sizeMm: bounds.map(([minimum, maximum]) => maximum - minimum) as unknown as Vec3
        }, "unite"));
      }
    }
    return unsupported("The two blocks overlap, but their union is not one exact rectangular prism in the bounded evaluator.", [input.target.id, input.tool.id], "Align two dimensions exactly and overlap or touch along the remaining axis.");
  }
  if (input.target.shape === "cylinder" && input.tool.shape === "cylinder"
    && close(input.target.translationMm[0], input.tool.translationMm[0]) && close(input.target.translationMm[1], input.tool.translationMm[1])
    && close(input.target.sizeMm[0], input.tool.sizeMm[0])) {
    const left = bodyIntervals(input.target)[2]!;
    const right = bodyIntervals(input.tool)[2]!;
    if (intervalsTouch(left, right)) {
      const minimum = Math.min(left[0], right[0]); const maximum = Math.max(left[1], right[1]);
      return success(withBooleanTrace(input, { ...input.target, translationMm: [input.target.translationMm[0], input.target.translationMm[1], (minimum + maximum) / 2], sizeMm: [input.target.sizeMm[0], input.target.sizeMm[0], maximum - minimum] }, "unite"));
    }
  }
  return unsupported("Unite supports collinear equal-diameter cylinders or blocks whose exact union remains a block.", [input.target.id, input.tool.id], "Align compatible analytic operands or use a qualified external B-rep kernel.");
}

function subtractBodies(input: { readonly operationId: string; readonly target: PartPreviewBody; readonly tool: PartPreviewBody }): PartFeatureResult<PartPreviewBody> {
  if (hasShapeModifiers(input.target) || input.tool.shape !== "cylinder" || !throughTarget(input.target, input.tool)) {
    return unsupported("Subtract currently supports one plain block/cylinder target and one coaxial through-cylinder tool.", [input.target.id, input.tool.id], "Align the tool on the target axis and make it span the complete target height.");
  }
  if (!(["block", "cylinder"] as const).includes(input.target.shape as "block" | "cylinder")
    || !close(input.target.translationMm[0], input.tool.translationMm[0]) || !close(input.target.translationMm[1], input.tool.translationMm[1])) {
    return unsupported("The cylinder tool must be coaxial with a block or cylinder target.", [input.target.id, input.tool.id], "Match target/tool X and Y center coordinates and keep both rotations at zero.");
  }
  const maximum = Math.min(input.target.sizeMm[0], input.target.sizeMm[1]) - MIN_WALL_MM * 2;
  if (input.tool.sizeMm[0] >= maximum) return unsupported("The subtract tool leaves less than the 0.5 mm supported wall.", [input.target.id, input.tool.id], `Use a tool diameter below ${round(maximum)} mm.`);
  return success(withBooleanTrace(input, { ...input.target, boreDiameterMm: input.tool.sizeMm[0] }, "subtract"));
}

function withBooleanTrace(input: { readonly operationId: string; readonly target: PartPreviewBody; readonly tool: PartPreviewBody }, body: PartPreviewBody, kind: "unite" | "subtract"): PartPreviewBody {
  return { ...body, featureTrace: { kind, operationId: input.operationId, parentIds: [input.target.id, input.tool.id] } };
}

function throughTarget(target: PartPreviewBody, tool: PartPreviewBody): boolean {
  const targetZ = bodyIntervals(target)[2]!; const toolZ = bodyIntervals(tool)[2]!;
  return toolZ[0] <= targetZ[0] + EPSILON && toolZ[1] >= targetZ[1] - EPSILON;
}

function bodyIntervals(body: PartPreviewBody): readonly (readonly [number, number])[] {
  return body.translationMm.map((center, axis) => [center - body.sizeMm[axis]! / 2, center + body.sizeMm[axis]! / 2] as const);
}

function intervalsTouch(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[1] >= right[0] - EPSILON && right[1] >= left[0] - EPSILON;
}

function sameInterval(left: readonly [number, number], right: readonly [number, number]): boolean {
  return close(left[0], right[0]) && close(left[1], right[1]);
}

function axisAligned(body: PartPreviewBody): boolean {
  return body.rotationDeg.every((value) => Math.abs(value) < EPSILON);
}

function hasShapeModifiers(body: PartPreviewBody): boolean {
  return body.boreDiameterMm !== undefined || body.edgeTreatment !== undefined || body.shellThicknessMm !== undefined || body.draftAngleDeg !== undefined || body.shape === "revolved";
}

function boreFits(body: PartPreviewBody, size: Vec3): boolean {
  return body.boreDiameterMm === undefined || body.boreDiameterMm <= Math.min(size[0], size[1]) - MIN_WALL_MM * 2;
}

function faceAxis(face: PartBodyFaceId): 0 | 1 | 2 {
  return face.startsWith("x-") ? 0 : face.startsWith("y-") ? 1 : 2;
}

function rotateLocalVector(vector: Vec3, rotationDeg: Vec3): Vec3 {
  const [x, y, z] = rotationDeg.map((value) => value * Math.PI / 180) as unknown as Vec3;
  const cx = Math.cos(x); const sx = Math.sin(x);
  const cy = Math.cos(y); const sy = Math.sin(y);
  const cz = Math.cos(z); const sz = Math.sin(z);
  return [
    (cy * cz) * vector[0] + (-cy * sz) * vector[1] + sy * vector[2],
    (cx * sz + sx * cz * sy) * vector[0] + (cx * cz - sx * sz * sy) * vector[1] + (-sx * cy) * vector[2],
    (sx * sz - cx * cz * sy) * vector[0] + (sx * cz + cx * sz * sy) * vector[1] + (cx * cy) * vector[2]
  ];
}

function add(left: Vec3, right: Vec3): Vec3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function success<T>(value: T): PartFeatureResult<T> {
  return { ok: true, value };
}

function unsupported(message: string, relatedIds: readonly string[], recovery: string): PartFeatureResult<never> {
  return { ok: false, message, relatedIds, recovery };
}

function deleteMutable<T extends object, K extends keyof T>(target: T, key: K): void {
  delete (target as Partial<T>)[key];
}
