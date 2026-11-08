import { evidenceAndSolidTests } from "./evidence-and-solid.test.js";
import { exchange3dTests } from "./exchange-3d.test.js";
import { modelAndCommandTests } from "./model-and-commands.test.js";
import { revisionBoundaryTests } from "./revision-boundaries.test.js";
import { sketchTests } from "./sketch.test.js";
import { sketchRegionTests } from "./sketch-regions.test.js";
import { sketchCameraTests } from "./sketch-camera.test.js";
import { sketchInteractionTests } from "./sketch-interaction.test.js";
import { sketchConstraintFitTests } from "./sketch-constraint-fit.test.js";
import { sketchInferenceTests } from "./sketch-inference.test.js";
import { sketchDynamicInputTests } from "./sketch-dynamic-input.test.js";
import { sketchPointConstraintTests } from "./sketch-point-constraints.test.js";
import { sketchAutoConstraintTests } from "./sketch-auto-constraints.test.js";
import { sketchDragTests } from "./sketch-drag.test.js";
import { sketchDimensionLayoutTests } from "./sketch-dimension-layout.test.js";
import { sketchShapeTests } from "./sketch-shapes.test.js";
import { sketchEllipseTests } from "./sketch-ellipse.test.js";
import { designTimelineTests } from "./design-timeline.test.js";
import { designRegenerationTests } from "./design-regeneration.test.js";
import { solidMetricsTests } from "./solid-metrics.test.js";
import { designLabelTests } from "./design-labels.test.js";
import { designChainTests } from "./design-chain.test.js";
import { designReplayTests } from "./design-replay.test.js";
import { planarFaceTests } from "./planar-faces.test.js";
import { menuModelTests } from "./menu-model.test.js";
import { mcpRecipeTests } from "./mcp-recipes.test.js";
import { selectionMetricTests } from "./selection-metrics.test.js";
import { sketchSolverTests } from "./sketch-solver.test.js";
import { sketchEditToolTests } from "./sketch-edit-tools.test.js";
import { meshBooleanTests } from "./mesh-boolean.test.js";
import { meshModifyTests } from "./mesh-modify.test.js";
import { meshCheckTests } from "./mesh-check.test.js";
import { bodyAnalysisTests } from "./body-analysis.test.js";
import { viewportAnalysisTests } from "./viewport-analysis.test.js";
import { analysisSessionTests } from "./analysis-session.test.js";
import { onViewAndMarkingTests } from "./on-view-and-marking.test.js";
import { holeWizardTests } from "./hole-wizard.test.js";
import { sketchChamferModeTests } from "./sketch-chamfer-modes.test.js";
import { sketchConstraintsWpTests } from "./sketch-constraints-wp.test.js";
import { sketchArcAndSlotModeTests } from "./sketch-arc-and-slot-modes.test.js";
import { sketchCurveToolTests } from "./sketch-curve-tools.test.js";
import { sweepAndLoftTests } from "./sweep-and-loft.test.js";
import { edgeShellDraftTests } from "./edge-shell-draft.test.js";
import { constructionAxesAndPointsTests } from "./construction-axes-and-points.test.js";
import { tangentLoftSweepPathTests } from "./tangent-loft-sweep-path.test.js";
import { loftResampleRailTwistTests } from "./loft-resample-rail-twist.test.js";
import { frenetTangencyDirectEditTests } from "./frenet-tangency-direct-edit.test.js";
import { faceHelixDimStylesTests } from "./face-helix-dim-styles.test.js";
import { bigPushTests } from "./big-push.test.js";
import { sheetMetalTests } from "./sheet-metal.test.js";
import { sheetMetalAdvancedTests } from "./sheet-metal-advanced.test.js";
import { sheetMetalTimelineTests } from "./sheet-metal-timeline.test.js";
import { sheetMetalCommandTests } from "./sheet-metal-commands.test.js";
import { inspectTransformEdgeFlangeTests } from "./inspect-transform-edge-flange.test.js";
import { solidOperationsIntegrationTests } from "./solid-operations-integration.test.js";
import { domeParamsStretchFlatTests } from "./dome-params-stretch-flat.test.js";
import { reliefPickHoleDragTests } from "./relief-pick-hole-drag.test.js";
import { holeTests } from "./hole.test.js";
import { patternTests } from "./pattern.test.js";
import { bodyEditGeometryTests } from "./body-edits.test.js";
import { bodyEditHandlerTests, bodyEditTimelineTests } from "./body-edit-timeline.test.js";
import { bodyFlexTests } from "./body-flex.test.js";
import { bodyWebTests, bodyWebTimelineTests } from "./body-web.test.js";
import { bodyWrapTests, bodyWrapTimelineTests } from "./body-wrap.test.js";
import { bodyEditFlowTests, bodyEditMenuTests } from "./body-edit-flows.test.js";
import { primitiveBodyTests } from "./primitive-bodies.test.js";
import { planesAndBindersTests } from "./planes-and-binders.test.js";
import { constructionUiTests } from "./construction-ui.test.js";
import { planeTiltTests } from "./plane-tilt.test.js";
import { planeFrameTests } from "./plane-frame.test.js";
import { sketchProjectTests } from "./sketch-project.test.js";
import { constructionPlaneTests } from "./construction-planes.test.js";
import { assemblyMeshTests } from "./assembly-mesh.test.js";
import { assemblyMateTests } from "./assembly-mates.test.js";
import { workbenchCoreTests } from "./workbench-core.test.js";
import { workbenchDrawingTests } from "./workbench-drawing.test.js";
import { workbenchGeometryTests } from "./workbench-geometry.test.js";
import { workbenchMcpTests } from "./workbench-mcp.test.js";
import { workbenchTemplateTests } from "./workbench-templates.test.js";
import { workbenchElectricalTests } from "./workbench-electrical.test.js";
import { workbenchElectromechanicalTests } from "./workbench-electromechanical.test.js";
import { workbenchVehicleTests } from "./workbench-vehicle.test.js";
import { workbenchHealthTests } from "./workbench-health.test.js";
import { workbenchMasterCartTests } from "./workbench-master-cart.test.js";
import { workbenchInteractionTests } from "./workbench-interaction.test.js";
import { workbenchPartFeatureTests } from "./workbench-part-features.test.js";
import { workbenchEngineeringIntentTests } from "./workbench-engineering-intent.test.js";
import { publicReleaseTests } from "./public-release.test.js";
import { fileWorkspaceTests } from "./file-workspace.test.js";
import { cameraLandmarkTests } from "./camera-landmarks.test.js";
import { topologyNamingTests } from "./topology-naming.test.js";
import { sketchSplitJogTests } from "./sketch-split-jog.test.js";
import { sketchPathMirrorMoveTests } from "./sketch-path-mirror-move.test.js";
import { sketchClipboardTests } from "./sketch-clipboard.test.js";
import { sketchRepairTests } from "./sketch-repair.test.js";
import { extentTerminationTests } from "./extent-terminations.test.js";
import { revolveTerminationTests } from "./revolve-terminations.test.js";
import { reachUiTests } from "./reach-ui.test.js";
import { expressionTests } from "./expressions.test.js";
import { designParameterTests } from "./design-parameters.test.js";
import { parameterDialogTests } from "./parameter-dialogs.test.js";
import { edgeBlendKernelTests, edgeBlendRimTests } from "./edge-blend.test.js";
import { edgeBlendStepTests } from "./edge-blend-steps.test.js";
import { limitsSurfaceTests } from "./limits-surface-suite.test.js";
import { sketchTextObjectTests } from "./sketch-text-objects.test.js";
import { sketchPatternObjectTests } from "./sketch-pattern-objects.test.js";
import type { TestCase } from "./test-kit.js";

const tests: readonly TestCase[] = [
  ...modelAndCommandTests,
  ...sketchTests,
  ...sketchRegionTests,
  ...sketchCameraTests,
  ...sketchInteractionTests,
  ...sketchConstraintFitTests,
  ...sketchInferenceTests,
  ...sketchDynamicInputTests,
  ...sketchPointConstraintTests,
  ...sketchAutoConstraintTests,
  ...sketchDragTests,
  ...sketchDimensionLayoutTests,
  ...sketchShapeTests,
  ...sketchEllipseTests,
  ...designTimelineTests,
  ...designRegenerationTests,
  ...solidMetricsTests,
  ...designLabelTests,
  ...designChainTests,
  ...designReplayTests,
  ...planarFaceTests,
  ...menuModelTests,
  ...mcpRecipeTests,
  ...selectionMetricTests,
  ...sketchSolverTests,
  ...sketchEditToolTests,
  ...sketchSplitJogTests,
  ...sketchPathMirrorMoveTests,
  ...sketchClipboardTests,
  ...sketchRepairTests,
  ...meshBooleanTests,
  ...meshModifyTests,
  ...meshCheckTests,
  ...bodyAnalysisTests,
  ...viewportAnalysisTests,
  ...analysisSessionTests,
  ...onViewAndMarkingTests,
  ...holeWizardTests,
  ...sketchChamferModeTests,
  ...sketchConstraintsWpTests,
  ...sketchArcAndSlotModeTests,
  ...sketchCurveToolTests,
  ...sweepAndLoftTests,
  ...edgeShellDraftTests,
  ...constructionAxesAndPointsTests,
  ...tangentLoftSweepPathTests,
  ...loftResampleRailTwistTests,
  ...frenetTangencyDirectEditTests,
  ...faceHelixDimStylesTests,
  ...bigPushTests,
  ...sheetMetalTests,
  ...sheetMetalAdvancedTests,
  ...sheetMetalTimelineTests,
  ...sheetMetalCommandTests,
  ...inspectTransformEdgeFlangeTests,
  ...reliefPickHoleDragTests,
  ...holeTests,
  ...patternTests,
  ...bodyEditGeometryTests,
  ...bodyEditTimelineTests,
  ...bodyEditHandlerTests,
  ...bodyFlexTests,
  ...bodyWebTests,
  ...bodyWebTimelineTests,
  ...bodyWrapTests,
  ...bodyWrapTimelineTests,
  ...bodyEditFlowTests,
  ...bodyEditMenuTests,
  ...primitiveBodyTests,
  ...planesAndBindersTests,
  ...constructionUiTests,
  ...planeTiltTests,
  ...planeFrameTests,
  ...sketchProjectTests,
  ...solidOperationsIntegrationTests,
  ...domeParamsStretchFlatTests,
  ...constructionPlaneTests,
  ...assemblyMeshTests,
  ...assemblyMateTests,
  ...evidenceAndSolidTests,
  ...exchange3dTests,
  ...revisionBoundaryTests,
  ...workbenchCoreTests,
  ...workbenchGeometryTests,
  ...workbenchDrawingTests,
  ...workbenchTemplateTests,
  ...workbenchElectricalTests,
  ...workbenchElectromechanicalTests,
  ...workbenchVehicleTests,
  ...workbenchHealthTests,
  ...workbenchMasterCartTests,
  ...workbenchInteractionTests,
  ...cameraLandmarkTests,
  ...workbenchPartFeatureTests,
  ...workbenchEngineeringIntentTests,
  ...workbenchMcpTests,
  ...fileWorkspaceTests,
  ...publicReleaseTests,
  ...topologyNamingTests,
  ...extentTerminationTests,
  ...revolveTerminationTests,
  ...reachUiTests,
  ...expressionTests,
  ...designParameterTests,
  ...parameterDialogTests,
  ...edgeBlendKernelTests,
  ...edgeBlendRimTests,
  ...edgeBlendStepTests,
  ...limitsSurfaceTests,
  ...sketchTextObjectTests,
  ...sketchPatternObjectTests
];
let failures = 0;

for (const test of tests) {
  try {
    await test.run();
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${test.name}`);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

console.log(`${tests.length - failures}/${tests.length} tests passed`);
if (failures > 0) throw new Error(`${failures} test${failures === 1 ? "" : "s"} failed.`);
