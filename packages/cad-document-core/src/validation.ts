import { deepFreeze } from "./document.js";
import { deterministicFeatureOrder } from "./graph.js";
import {
  isCadId,
  isCadScopedId,
  type CadEntityKind,
  type ComponentId,
  type FeatureId,
  type OccurrenceId
} from "./ids.js";
import {
  CAD_DOCUMENT_FORMAT,
  CAD_DOCUMENT_SCHEMA_VERSION,
  type CadComponent,
  type CadDiagnostic,
  type CadDocument,
  type CadProject,
  type CadResult,
  type FeatureInputReference,
  type Transform3
} from "./types.js";

const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]{0,95}$/u;

export function validateCadDocument(input: unknown): CadResult<CadDocument> {
  const envelope = parseEnvelope(input);
  if (!envelope.ok) return envelope;
  const document = envelope.value;
  const diagnostics: CadDiagnostic[] = [];

  try {
    validateIdentity(document, diagnostics);
    validateComponents(document.project, diagnostics);
    validateOrigins(document.project, diagnostics);
    validateSketches(document.project, diagnostics);
    validateBodies(document.project, diagnostics);
    validateFeatures(document.project, diagnostics);
    validateOccurrences(document.project, diagnostics);
    validateJoints(document.project, diagnostics);
    validateDrawings(document, diagnostics);
    validateComponentCycles(document.project, diagnostics);
    validateOccurrenceCycles(document.project, diagnostics);
    const featureOrder = deterministicFeatureOrder(document);
    if (!featureOrder.ok) diagnostics.push(...featureOrder.diagnostics);
  } catch (error) {
    diagnostics.push(problem(
      "INVALID_REFERENCE",
      "The document contains a malformed nested record.",
      [],
      error instanceof Error ? error.message : "Recreate the malformed record from a known valid document."
    ));
  }

  const errors = deduplicateDiagnostics(diagnostics).filter((diagnostic) => diagnostic.severity === "error");
  return errors.length === 0
    ? { ok: true, value: deepFreeze(structuredClone(document) as CadDocument) }
    : { ok: false, diagnostics: errors };
}

function parseEnvelope(input: unknown): CadResult<CadDocument> {
  if (!isRecord(input) || input.format !== CAD_DOCUMENT_FORMAT || input.schemaVersion !== CAD_DOCUMENT_SCHEMA_VERSION) {
    return invalidRoot("The root format or schema version is unsupported.");
  }
  if (!isRecord(input.project)) return invalidRoot("The project record is missing.");
  const project = input.project;
  const collectionNames = ["components", "origins", "sketches", "bodies", "features", "occurrences", "joints", "drawings"] as const;
  for (const collectionName of collectionNames) {
    const collection = project[collectionName];
    if (!Array.isArray(collection) || !collection.every(isRecord)) {
      return invalidRoot(`Project collection ${collectionName} must be an array of records.`);
    }
  }
  if (!Array.isArray(project.diagnostics)) return invalidRoot("Project diagnostics must be an array.");
  return { ok: true, value: input as unknown as CadDocument };
}

function validateIdentity(document: CadDocument, diagnostics: CadDiagnostic[]): void {
  if (!Number.isSafeInteger(document.revision) || document.revision < 0
    || (document.revision === 0 ? document.parentRevision !== null : document.parentRevision !== document.revision - 1)) {
    diagnostics.push(problem("INVALID_REFERENCE", "The document revision chain is invalid.", [], "Restore a monotonic revision and its immediate parent revision."));
  }
  if (typeof document.applicationVersion !== "string" || document.applicationVersion.length === 0
    || typeof document.lastOperationId !== "string" || !OPERATION_ID_PATTERN.test(document.lastOperationId)) {
    diagnostics.push(problem("INVALID_REFERENCE", "The application version or last operation ID is invalid.", [], "Use a non-empty version and a stable prefixed operation ID."));
  }
  if (!isCadId(document.project.id, "project") || !isCadId(document.project.rootComponentId, "component")) {
    diagnostics.push(problem("ID_KIND_MISMATCH", "Project identity fields use an invalid ID kind.", [], "Create typed project and component IDs with the canonical ID factory."));
  }
  if (!validName(document.project.name)) {
    diagnostics.push(problem("INVALID_REFERENCE", "The project name is invalid.", [String(document.project.id)], "Use a project name containing 1-160 characters."));
  }
  if (!isRecord(document.project.units)
    || !["mm", "cm", "m", "in", "ft"].includes(document.project.units.length)
    || !["deg", "rad"].includes(document.project.units.angle)
    || !["g", "kg", "lb"].includes(document.project.units.mass)) {
    diagnostics.push(problem("INVALID_PARAMETER", "The project unit system is invalid.", [String(document.project.id)], "Select supported length, angle, and mass units."));
  }
  validateUniqueNodeIds(document.project, diagnostics);
}

function validateUniqueNodeIds(project: CadProject, diagnostics: CadDiagnostic[]): void {
  const collections: readonly [CadEntityKind, readonly { readonly id: string }[]][] = [
    ["project", [project]],
    ["component", project.components],
    ["origin", project.origins],
    ["sketch", project.sketches],
    ["body", project.bodies],
    ["feature", project.features],
    ["occurrence", project.occurrences],
    ["joint", project.joints],
    ["drawing", project.drawings]
  ];
  const allIds = new Set<string>();
  for (const [kind, records] of collections) {
    const ids = new Set<string>();
    for (const record of records) {
      if (!isCadId(record.id, kind)) {
        diagnostics.push(problem("ID_KIND_MISMATCH", `A ${kind} record has an invalid stable ID.`, [String(record.id)], `Reassign it with the ${kind}: prefix.`));
      }
      if (ids.has(record.id) || allIds.has(record.id)) {
        diagnostics.push(problem("DUPLICATE_ID", `Duplicate canonical ID: ${record.id}`, [record.id], "Assign a new stable ID and update its references."));
      }
      ids.add(record.id);
      allIds.add(record.id);
    }
  }
}

function validateComponents(project: CadProject, diagnostics: CadDiagnostic[]): void {
  const components = new Map(project.components.map((component) => [component.id, component] as const));
  if (!components.has(project.rootComponentId)) {
    diagnostics.push(problem("MISSING_REFERENCE", "The root component does not exist.", [project.rootComponentId], "Restore the root component or update rootComponentId."));
  }
  for (const component of project.components) {
    if (!validName(component.name) || !isCadId(component.originId, "origin")) {
      diagnostics.push(problem("INVALID_REFERENCE", `Component ${component.id} has invalid identity data.`, [component.id], "Repair its name and origin reference."));
    }
    if (component.id === project.rootComponentId && component.parentComponentId !== null) {
      diagnostics.push(problem("OWNERSHIP_MISMATCH", "The root component cannot have a parent.", [component.id], "Set its parent component to null."));
    }
    if (component.parentComponentId !== null) {
      const parent = components.get(component.parentComponentId);
      if (parent === undefined) missing(diagnostics, component.id, component.parentComponentId);
      else if (!parent.childComponentIds.includes(component.id)) ownership(diagnostics, component.id, parent.id, "child component");
    }
    validateOwnedIds(component, project, diagnostics);
    if (component.rollbackAfterFeatureId !== null && !component.featureIds.includes(component.rollbackAfterFeatureId)) {
      diagnostics.push(problem("ROLLBACK_TARGET_INVALID", `Rollback target ${component.rollbackAfterFeatureId} is outside the component timeline.`, [component.id, component.rollbackAfterFeatureId], "Choose a feature in the same component timeline or clear rollback."));
    }
    checkDuplicateList(component.childComponentIds, component.id, "child component", diagnostics);
    checkDuplicateList(component.sketchIds, component.id, "sketch", diagnostics);
    checkDuplicateList(component.bodyIds, component.id, "body", diagnostics);
    checkDuplicateList(component.featureIds, component.id, "feature timeline", diagnostics);
    checkDuplicateList(component.occurrenceIds, component.id, "occurrence", diagnostics);
    checkDuplicateList(component.jointIds, component.id, "joint", diagnostics);
    checkDuplicateList(component.drawingIds, component.id, "drawing", diagnostics);
  }
}

function validateOwnedIds(component: CadComponent, project: CadProject, diagnostics: CadDiagnostic[]): void {
  const groups: readonly [string, readonly string[], ReadonlyMap<string, { readonly componentId?: string; readonly ownerComponentId?: string }>][] = [
    ["sketch", component.sketchIds, new Map(project.sketches.map((item) => [item.id, item]))],
    ["body", component.bodyIds, new Map(project.bodies.map((item) => [item.id, item]))],
    ["feature", component.featureIds, new Map(project.features.map((item) => [item.id, item]))],
    ["occurrence", component.occurrenceIds, new Map(project.occurrences.map((item) => [item.id, item]))],
    ["joint", component.jointIds, new Map(project.joints.map((item) => [item.id, item]))],
    ["drawing", component.drawingIds, new Map(project.drawings.map((item) => [item.id, item]))]
  ];
  for (const [label, ids, records] of groups) {
    for (const id of ids) {
      const record = records.get(id);
      if (record === undefined) missing(diagnostics, component.id, id);
      else if ((record.componentId ?? record.ownerComponentId) !== component.id) ownership(diagnostics, id, component.id, label);
    }
  }
  for (const childId of component.childComponentIds) {
    const child = project.components.find((candidate) => candidate.id === childId);
    if (child === undefined) missing(diagnostics, component.id, childId);
    else if (child.parentComponentId !== component.id) ownership(diagnostics, child.id, component.id, "child component");
  }
}

function validateOrigins(project: CadProject, diagnostics: CadDiagnostic[]): void {
  for (const origin of project.origins) {
    const component = project.components.find((candidate) => candidate.id === origin.componentId);
    if (component === undefined) missing(diagnostics, origin.id, origin.componentId);
    else if (component.originId !== origin.id) ownership(diagnostics, origin.id, component.id, "origin");
    validateTransform(origin.transform, origin.id, diagnostics);
    for (const vector of Object.values(origin.axes)) validateVector(vector, origin.id, diagnostics);
    for (const plane of Object.values(origin.planes)) {
      validateVector(plane[0], origin.id, diagnostics);
      validateVector(plane[1], origin.id, diagnostics);
    }
  }
}

function validateSketches(project: CadProject, diagnostics: CadDiagnostic[]): void {
  for (const sketch of project.sketches) {
    if (!project.components.some((component) => component.id === sketch.componentId)) missing(diagnostics, sketch.id, sketch.componentId);
    validateTransform(sketch.transform, sketch.id, diagnostics);
    if (sketch.support.kind === "origin-plane") {
      const supportOriginId = sketch.support.originId;
      const origin = project.origins.find((candidate) => candidate.id === supportOriginId);
      if (origin === undefined) missing(diagnostics, sketch.id, supportOriginId);
      else if (origin.componentId !== sketch.componentId) ownership(diagnostics, origin.id, sketch.componentId, "sketch support");
    } else {
      validateTopologyReference(sketch.support.face, project, sketch.id, diagnostics);
      if (sketch.support.face.subshape !== "face" || sketch.support.face.expectedGeometry !== "planar") {
        diagnostics.push(problem("INVALID_SKETCH", `Sketch ${sketch.id} requires a planar face support.`, [sketch.id], "Select an origin plane or a persistent planar face."));
      }
    }
    const entityIds = new Set<string>();
    for (const entity of sketch.entities) {
      if (!isCadScopedId(entity.id, "sketch-entity") || entityIds.has(entity.id)) {
        diagnostics.push(problem(entityIds.has(entity.id) ? "DUPLICATE_ID" : "ID_KIND_MISMATCH", `Sketch ${sketch.id} has an invalid entity ID.`, [sketch.id, String(entity.id)], "Assign a unique sketch-entity ID."));
      }
      entityIds.add(entity.id);
      validateSketchEntity(entity, sketch.id, diagnostics);
    }
    const localIds = new Set(entityIds);
    for (const constraint of sketch.constraints) {
      validateScopedRecordId(constraint.id, "sketch-constraint", localIds, sketch.id, diagnostics);
      if (constraint.entityIds.length === 0 || constraint.entityIds.some((id) => !entityIds.has(id))) {
        diagnostics.push(problem("INVALID_SKETCH", `Constraint ${constraint.id} references missing sketch geometry.`, [sketch.id, constraint.id, ...constraint.entityIds], "Restore the referenced entities or delete the constraint."));
      }
    }
    for (const dimension of sketch.dimensions) {
      validateScopedRecordId(dimension.id, "sketch-dimension", localIds, sketch.id, diagnostics);
      if (dimension.entityIds.length === 0 || dimension.entityIds.some((id) => !entityIds.has(id)) || !validExpression(dimension.value)) {
        diagnostics.push(problem("INVALID_SKETCH", `Dimension ${dimension.id} is invalid.`, [sketch.id, dimension.id], "Repair its entity references and dimensional expression."));
      }
      validateVector2(dimension.placementMeters, sketch.id, diagnostics);
    }
    if (sketch.solveState.degreesOfFreedom !== null
      && (!Number.isSafeInteger(sketch.solveState.degreesOfFreedom) || sketch.solveState.degreesOfFreedom < 0)) {
      diagnostics.push(problem("INVALID_SKETCH", `Sketch ${sketch.id} has an invalid degree-of-freedom count.`, [sketch.id], "Re-run the constraint solver."));
    }
  }
}

function validateBodies(project: CadProject, diagnostics: CadDiagnostic[]): void {
  for (const body of project.bodies) {
    const component = project.components.find((candidate) => candidate.id === body.componentId);
    if (component === undefined) missing(diagnostics, body.id, body.componentId);
    else if (!component.bodyIds.includes(body.id)) ownership(diagnostics, body.id, component.id, "body");
    if (body.generatedByFeatureId !== null) {
      const feature = project.features.find((candidate) => candidate.id === body.generatedByFeatureId);
      if (feature === undefined) missing(diagnostics, body.id, body.generatedByFeatureId);
      else if (feature.componentId !== body.componentId || !feature.outputBodyIds.includes(body.id)) ownership(diagnostics, body.id, feature.id, "feature output body");
    }
    if (!Number.isSafeInteger(body.topologyRevision) || body.topologyRevision < 0
      || (body.representation === "empty") !== (body.geometryHandle === null)) {
      diagnostics.push(problem("INVALID_PARAMETER", `Body ${body.id} has invalid representation state.`, [body.id], "Repair its topology revision and geometry handle."));
    }
  }
}

function validateFeatures(project: CadProject, diagnostics: CadDiagnostic[]): void {
  const featureIds = new Set(project.features.map((feature) => feature.id));
  for (const feature of project.features) {
    const component = project.components.find((candidate) => candidate.id === feature.componentId);
    if (component === undefined) missing(diagnostics, feature.id, feature.componentId);
    else if (!component.featureIds.includes(feature.id)) ownership(diagnostics, feature.id, component.id, "feature timeline");
    checkDuplicateList(feature.dependencies, feature.id, "dependency", diagnostics);
    if (feature.dependencies.includes(feature.id)) {
      diagnostics.push(problem("FEATURE_CYCLE", `Feature ${feature.id} depends on itself.`, [feature.id], "Remove the self-dependency."));
    }
    for (const dependencyId of feature.dependencies) if (!featureIds.has(dependencyId)) missing(diagnostics, feature.id, dependencyId);
    for (const input of feature.inputs) validateInputReference(input, project, feature.id, diagnostics);
    const parameterNames = new Set<string>();
    for (const parameter of feature.parameters) {
      if (!/^[a-z][a-zA-Z0-9_]{0,63}$/u.test(parameter.name) || parameterNames.has(parameter.name) || !validExpression(parameter.value)) {
        diagnostics.push(problem("INVALID_PARAMETER", `Feature ${feature.id} has an invalid or duplicate parameter.`, [feature.id, parameter.name], "Use a unique parameter name and a finite evaluated value."));
      }
      parameterNames.add(parameter.name);
    }
    checkDuplicateList(feature.outputBodyIds, feature.id, "output body", diagnostics);
    for (const bodyId of feature.outputBodyIds) {
      const body = project.bodies.find((candidate) => candidate.id === bodyId);
      if (body === undefined) missing(diagnostics, feature.id, bodyId);
      else if (body.componentId !== feature.componentId) ownership(diagnostics, body.id, feature.componentId, "feature output body");
    }
    if (feature.suppressed && feature.status !== "suppressed") {
      diagnostics.push(problem("INVALID_TIMELINE", `Suppressed feature ${feature.id} has non-suppressed status.`, [feature.id], "Set the status to suppressed."));
    }
  }
}

function validateOccurrences(project: CadProject, diagnostics: CadDiagnostic[]): void {
  for (const occurrence of project.occurrences) {
    const owner = project.components.find((component) => component.id === occurrence.ownerComponentId);
    if (owner === undefined) missing(diagnostics, occurrence.id, occurrence.ownerComponentId);
    else if (!owner.occurrenceIds.includes(occurrence.id)) ownership(diagnostics, occurrence.id, owner.id, "occurrence");
    if (!project.components.some((component) => component.id === occurrence.componentId)) missing(diagnostics, occurrence.id, occurrence.componentId);
    if (occurrence.parentOccurrenceId !== null) {
      const parent = project.occurrences.find((candidate) => candidate.id === occurrence.parentOccurrenceId);
      if (parent === undefined) missing(diagnostics, occurrence.id, occurrence.parentOccurrenceId);
      else if (parent.ownerComponentId !== occurrence.ownerComponentId) ownership(diagnostics, occurrence.id, parent.id, "nested occurrence");
    }
    validateTransform(occurrence.transform, occurrence.id, diagnostics);
  }
}

function validateJoints(project: CadProject, diagnostics: CadDiagnostic[]): void {
  for (const joint of project.joints) {
    const component = project.components.find((candidate) => candidate.id === joint.componentId);
    if (component === undefined) missing(diagnostics, joint.id, joint.componentId);
    else if (!component.jointIds.includes(joint.id)) ownership(diagnostics, joint.id, component.id, "joint");
    const first = project.occurrences.find((occurrence) => occurrence.id === joint.first.occurrenceId);
    const second = project.occurrences.find((occurrence) => occurrence.id === joint.second.occurrenceId);
    if (first === undefined) missing(diagnostics, joint.id, joint.first.occurrenceId);
    if (second === undefined) missing(diagnostics, joint.id, joint.second.occurrenceId);
    if (first !== undefined && first.ownerComponentId !== joint.componentId) ownership(diagnostics, first.id, joint.componentId, "joint endpoint");
    if (second !== undefined && second.ownerComponentId !== joint.componentId) ownership(diagnostics, second.id, joint.componentId, "joint endpoint");
    if (joint.first.occurrenceId === joint.second.occurrenceId) {
      diagnostics.push(problem("INVALID_JOINT", `Joint ${joint.id} connects an occurrence to itself.`, [joint.id, joint.first.occurrenceId], "Select two different occurrences."));
    }
    validateTransform(joint.first.transform, joint.id, diagnostics);
    validateTransform(joint.second.transform, joint.id, diagnostics);
    if (joint.first.geometry !== null) validateTopologyReference(joint.first.geometry, project, joint.id, diagnostics);
    if (joint.second.geometry !== null) validateTopologyReference(joint.second.geometry, project, joint.id, diagnostics);
    if (joint.motionLinkJointId !== null && !project.joints.some((candidate) => candidate.id === joint.motionLinkJointId)) missing(diagnostics, joint.id, joint.motionLinkJointId);
    if (joint.motionRatio !== null && (!Number.isFinite(joint.motionRatio) || joint.motionRatio === 0)) {
      diagnostics.push(problem("INVALID_JOINT", `Joint ${joint.id} has an invalid motion ratio.`, [joint.id], "Use a finite non-zero ratio."));
    }
    validateLimits(joint.limits.linearMeters, joint.id, diagnostics);
    validateLimits(joint.limits.angularRadians, joint.id, diagnostics);
  }
}

function validateDrawings(document: CadDocument, diagnostics: CadDiagnostic[]): void {
  const project = document.project;
  for (const drawing of project.drawings) {
    const component = project.components.find((candidate) => candidate.id === drawing.componentId);
    if (component === undefined) missing(diagnostics, drawing.id, drawing.componentId);
    else if (!component.drawingIds.includes(drawing.id)) ownership(diagnostics, drawing.id, component.id, "drawing");
    if (drawing.sourceOccurrenceId !== null && !project.occurrences.some((occurrence) => occurrence.id === drawing.sourceOccurrenceId)) missing(diagnostics, drawing.id, drawing.sourceOccurrenceId);
    if (!Number.isSafeInteger(drawing.modelRevision) || drawing.modelRevision < 0 || drawing.modelRevision > document.revision) {
      diagnostics.push(problem("INVALID_DRAWING", `Drawing ${drawing.id} has an invalid model revision.`, [drawing.id], "Regenerate it against a current or earlier document revision."));
    }
    const viewIds = new Set<string>();
    for (const view of drawing.views) {
      validateScopedRecordId(view.id, "drawing-view", viewIds, drawing.id, diagnostics);
      validateTransform(view.orientation, drawing.id, diagnostics);
      validateVector2(view.positionMeters, drawing.id, diagnostics);
      if (!Number.isFinite(view.scale) || view.scale <= 0) diagnostics.push(problem("INVALID_DRAWING", `Drawing view ${view.id} has invalid scale.`, [drawing.id, view.id], "Use a finite positive scale."));
      for (const association of view.associations) {
        validateInputReference(association.reference, project, drawing.id, diagnostics);
        if (association.topologyRevision !== null && (!Number.isSafeInteger(association.topologyRevision) || association.topologyRevision < 0)) {
          diagnostics.push(problem("INVALID_DRAWING", `Drawing view ${view.id} has invalid topology revision.`, [drawing.id, view.id], "Regenerate the association."));
        }
      }
    }
    for (const view of drawing.views) {
      if (view.parentViewId !== null && !viewIds.has(view.parentViewId)) missing(diagnostics, view.id, view.parentViewId);
    }
    const annotationIds = new Set<string>();
    for (const annotation of drawing.annotations) {
      validateScopedRecordId(annotation.id, "drawing-annotation", annotationIds, drawing.id, diagnostics);
      validateVector2(annotation.positionMeters, drawing.id, diagnostics);
      for (const association of annotation.associations) validateInputReference(association.reference, project, drawing.id, diagnostics);
    }
  }
}

function validateComponentCycles(project: CadProject, diagnostics: CadDiagnostic[]): void {
  const parents = new Map(project.components.map((component) => [component.id, component.parentComponentId] as const));
  for (const component of project.components) {
    const visited = new Set<ComponentId>();
    let cursor: ComponentId | null = component.id;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        diagnostics.push(problem("OWNERSHIP_MISMATCH", "The component hierarchy contains a cycle.", [...visited, cursor], "Remove one cyclic parent/child relationship."));
        break;
      }
      visited.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }
}

function validateOccurrenceCycles(project: CadProject, diagnostics: CadDiagnostic[]): void {
  const parents = new Map(project.occurrences.map((occurrence) => [occurrence.id, occurrence.parentOccurrenceId] as const));
  for (const occurrence of project.occurrences) {
    const visited = new Set<OccurrenceId>();
    let cursor: OccurrenceId | null = occurrence.id;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        diagnostics.push(problem("OCCURRENCE_CYCLE", "The occurrence hierarchy contains a cycle.", [...visited, cursor], "Remove one cyclic occurrence parent link."));
        break;
      }
      visited.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }
}

function validateInputReference(reference: FeatureInputReference, project: CadProject, ownerId: string, diagnostics: CadDiagnostic[]): void {
  if (!isRecord(reference) || typeof reference.kind !== "string") {
    diagnostics.push(problem("INVALID_REFERENCE", `Record ${ownerId} contains a malformed input reference.`, [ownerId], "Replace it with a typed canonical reference."));
    return;
  }
  if (reference.kind === "topology") {
    validateTopologyReference(reference, project, ownerId, diagnostics);
    return;
  }
  if (reference.kind === "sketch-element") {
    const sketch = project.sketches.find((candidate) => candidate.id === reference.sketchId);
    if (sketch === undefined) missing(diagnostics, ownerId, reference.sketchId);
    else if (!sketch.entities.some((entity) => entity.id === reference.entityId)) missing(diagnostics, ownerId, reference.entityId);
    return;
  }
  const collections: Readonly<Record<CadEntityKind, readonly { readonly id: string }[]>> = {
    project: [project],
    component: project.components,
    origin: project.origins,
    sketch: project.sketches,
    body: project.bodies,
    feature: project.features,
    occurrence: project.occurrences,
    joint: project.joints,
    drawing: project.drawings
  };
  if (!(reference.kind in collections) || !collections[reference.kind as CadEntityKind].some((record) => record.id === reference.id)) {
    missing(diagnostics, ownerId, String(reference.id));
  }
}

function validateTopologyReference(reference: Extract<FeatureInputReference, { readonly kind: "topology" }>, project: CadProject, ownerId: string, diagnostics: CadDiagnostic[]): void {
  const body = project.bodies.find((candidate) => candidate.id === reference.bodyId);
  const feature = project.features.find((candidate) => candidate.id === reference.sourceFeatureId);
  if (body === undefined) missing(diagnostics, ownerId, reference.bodyId);
  if (feature === undefined) missing(diagnostics, ownerId, reference.sourceFeatureId);
  if (body !== undefined && feature !== undefined
    && (body.componentId !== feature.componentId || !feature.outputBodyIds.includes(body.id))) {
    diagnostics.push(problem(
      "INVALID_REFERENCE",
      "A topology reference combines a body with a feature that does not produce or modify that body.",
      [ownerId, body.id, feature.id],
      "Resolve the persistent topology name from a feature output on the referenced body."
    ));
  }
  if (typeof reference.persistentName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,159}$/u.test(reference.persistentName)) {
    diagnostics.push(problem("INVALID_REFERENCE", "A topology reference uses an invalid persistent name.", [ownerId, String(reference.bodyId)], "Use a semantic topology name supplied by the exact-geometry adapter."));
  }
}

function validateTransform(transform: Transform3, ownerId: string, diagnostics: CadDiagnostic[]): void {
  if (!isRecord(transform)) {
    diagnostics.push(problem("INVALID_TRANSFORM", `Record ${ownerId} has no valid transform.`, [ownerId], "Restore an identity transform."));
    return;
  }
  validateVector(transform.translationMeters, ownerId, diagnostics);
  validateVector(transform.scale, ownerId, diagnostics, true);
  const rotation = transform.rotation;
  if (!Array.isArray(rotation) || rotation.length !== 4 || rotation.some((value) => !Number.isFinite(value))) {
    diagnostics.push(problem("INVALID_TRANSFORM", `Record ${ownerId} has an invalid quaternion.`, [ownerId], "Use four finite quaternion components."));
  } else if (Math.hypot(...rotation) < 1e-12) {
    diagnostics.push(problem("INVALID_TRANSFORM", `Record ${ownerId} has a zero quaternion.`, [ownerId], "Use a normalized non-zero quaternion."));
  }
}

function validateVector(vector: readonly number[], ownerId: string, diagnostics: CadDiagnostic[], positive = false): void {
  if (!Array.isArray(vector) || vector.length !== 3 || vector.some((value) => !Number.isFinite(value) || (positive && value <= 0))) {
    diagnostics.push(problem("INVALID_TRANSFORM", `Record ${ownerId} has an invalid 3D vector.`, [ownerId], "Use three finite values; scale values must be positive."));
  }
}

function validateVector2(vector: readonly number[], ownerId: string, diagnostics: CadDiagnostic[]): void {
  if (!Array.isArray(vector) || vector.length !== 2 || vector.some((value) => !Number.isFinite(value))) {
    diagnostics.push(problem("INVALID_PARAMETER", `Record ${ownerId} has an invalid 2D point.`, [ownerId], "Use two finite coordinates."));
  }
}

function validateSketchEntity(entity: CadProject["sketches"][number]["entities"][number], sketchId: string, diagnostics: CadDiagnostic[]): void {
  if (entity.type === "point") validateVector2(entity.pointMeters, sketchId, diagnostics);
  else if (entity.type === "line") {
    validateVector2(entity.startMeters, sketchId, diagnostics);
    validateVector2(entity.endMeters, sketchId, diagnostics);
  } else if (entity.type === "circle" || entity.type === "arc") {
    validateVector2(entity.centerMeters, sketchId, diagnostics);
    if (!Number.isFinite(entity.radiusMeters) || entity.radiusMeters <= 0) diagnostics.push(problem("INVALID_SKETCH", `Sketch ${sketchId} contains a non-positive radius.`, [sketchId, entity.id], "Use a finite positive radius."));
    if (entity.type === "arc" && (!Number.isFinite(entity.startAngleRadians) || !Number.isFinite(entity.endAngleRadians))) diagnostics.push(problem("INVALID_SKETCH", `Arc ${entity.id} contains invalid angles.`, [sketchId, entity.id], "Use finite start and end angles."));
  } else if (entity.type === "ellipse") {
    validateVector2(entity.centerMeters, sketchId, diagnostics);
    validateVector2(entity.majorAxisMeters, sketchId, diagnostics);
    if (![entity.majorRadiusMeters, entity.minorRadiusMeters].every((value) => Number.isFinite(value) && value > 0)) diagnostics.push(problem("INVALID_SKETCH", `Ellipse ${entity.id} has invalid radii.`, [sketchId, entity.id], "Use finite positive radii."));
  } else {
    for (const point of entity.controlPointsMeters) validateVector2(point, sketchId, diagnostics);
    if (entity.controlPointsMeters.length < entity.degree + 1) diagnostics.push(problem("INVALID_SKETCH", `Spline ${entity.id} has too few control points.`, [sketchId, entity.id], "Add enough control points for its degree."));
  }
}

function validExpression(expression: { readonly expression: string; readonly dimension: string; readonly value: unknown }): boolean {
  return typeof expression.expression === "string" && expression.expression.length > 0 && expression.expression.length <= 256
    && ["scalar", "length", "angle", "integer", "boolean", "text"].includes(expression.dimension)
    && (typeof expression.value === "string" || typeof expression.value === "boolean"
      || (typeof expression.value === "number" && Number.isFinite(expression.value)));
}

function validateScopedRecordId(
  id: string,
  kind: "sketch-constraint" | "sketch-dimension" | "drawing-view" | "drawing-annotation",
  existing: Set<string>,
  ownerId: string,
  diagnostics: CadDiagnostic[]
): void {
  if (!isCadScopedId(id, kind) || existing.has(id)) {
    diagnostics.push(problem(existing.has(id) ? "DUPLICATE_ID" : "ID_KIND_MISMATCH", `Record ${ownerId} has an invalid ${kind} ID.`, [ownerId, String(id)], `Assign a unique ${kind} ID.`));
  }
  existing.add(id);
}

function validateLimits(limits: readonly [number, number] | null, jointId: string, diagnostics: CadDiagnostic[]): void {
  if (limits !== null && (!Array.isArray(limits) || limits.length !== 2 || !Number.isFinite(limits[0]) || !Number.isFinite(limits[1]) || limits[0] > limits[1])) {
    diagnostics.push(problem("INVALID_JOINT", `Joint ${jointId} has invalid limits.`, [jointId], "Use finite ordered minimum and maximum limits."));
  }
}

function checkDuplicateList(ids: readonly string[], ownerId: string, label: string, diagnostics: CadDiagnostic[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) diagnostics.push(problem("DUPLICATE_ID", `${ownerId} lists ${label} ${id} more than once.`, [ownerId, id], `Remove the duplicate ${label} reference.`));
    seen.add(id);
  }
}

function validName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && name.length <= 160;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missing(diagnostics: CadDiagnostic[], ownerId: string, missingId: string): void {
  diagnostics.push(problem("MISSING_REFERENCE", `${ownerId} references missing record ${missingId}.`, [ownerId, missingId], "Restore the record or remove the stale reference."));
}

function ownership(diagnostics: CadDiagnostic[], recordId: string, ownerId: string, label: string): void {
  diagnostics.push(problem("OWNERSHIP_MISMATCH", `${recordId} is not reciprocally owned by ${ownerId} as a ${label}.`, [recordId, ownerId], "Repair both the owner ID and its membership list."));
}

function problem(
  code: CadDiagnostic["code"],
  message: string,
  relatedIds: readonly string[],
  recovery: string
): CadDiagnostic {
  return { code, severity: "error", message, relatedIds, recovery };
}

function invalidRoot(message: string): CadResult<never> {
  return { ok: false, diagnostics: [problem("INVALID_REFERENCE", message, [], "Open a supported canonical PS3D CAD document.")] };
}

function deduplicateDiagnostics(diagnostics: readonly CadDiagnostic[]): readonly CadDiagnostic[] {
  const byKey = new Map<string, CadDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${[...diagnostic.relatedIds].sort().join(",")}:${diagnostic.message}`;
    byKey.set(key, diagnostic);
  }
  return [...byKey.values()].sort((first, second) => {
    const firstKey = `${first.code}:${first.relatedIds.join(",")}:${first.message}`;
    const secondKey = `${second.code}:${second.relatedIds.join(",")}:${second.message}`;
    return firstKey.localeCompare(secondKey);
  });
}
