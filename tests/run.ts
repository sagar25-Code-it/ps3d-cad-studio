import { evidenceAndSolidTests } from "./evidence-and-solid.test.js";
import { exchange3dTests } from "./exchange-3d.test.js";
import { modelAndCommandTests } from "./model-and-commands.test.js";
import { revisionBoundaryTests } from "./revision-boundaries.test.js";
import { sketchTests } from "./sketch.test.js";
import { sketchRegionTests } from "./sketch-regions.test.js";
import { sketchArrangementTests } from "./sketch-arrangement.test.js";
import { sketchCameraTests } from "./sketch-camera.test.js";
import { sketchInteractionTests } from "./sketch-interaction.test.js";
import { sketchConstraintFitTests } from "./sketch-constraint-fit.test.js";
import { sketchInferenceTests } from "./sketch-inference.test.js";
import { sketchDynamicInputTests } from "./sketch-dynamic-input.test.js";
import { sketchInputExtrasTests } from "./sketch-input-extras.test.js";
import { sketchPointConstraintTests } from "./sketch-point-constraints.test.js";
import { sketchAutoConstraintTests } from "./sketch-auto-constraints.test.js";
import { sketchDragTests } from "./sketch-drag.test.js";
import { sketchDimensionLayoutTests } from "./sketch-dimension-layout.test.js";
import { sketchShapeTests } from "./sketch-shapes.test.js";
import { sketchEveryShape3Tests, sketchFit3Tests, sketchHotkeys3Tests, sketchSpline3Tests, sketchBuilderGuards3Tests, sketchShapeSnaps3Tests, sketchTypedEntry3Tests, sketchEllipseCrossing3Tests, sketchSnapRelations3Tests, sketchArcSlots3Tests, sketchShapes3Tests } from "./sketch-shapes3.test.js";
import { sketchArcSlotJointTests, sketchShapeJointTests } from "./sketch-shape-joints.test.js";
import { sketchRegularPolygonTests } from "./sketch-regular-polygon.test.js";
import { sketchCornerJoinTests } from "./sketch-corner-joins.test.js";
import { sketchDrawInferenceTests } from "./sketch-draw-inference.test.js";
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
import { sketchSolverSimultaneousTests } from "./sketch-solver-simultaneous.test.js";
import { sketchSolverDofTests } from "./sketch-solver-dof.test.js";
import { sketchSolverKindsTests } from "./sketch-solver-kinds.test.js";
import { sketchSolverWave2Tests } from "./sketch-solver-wave2.test.js";
import { sketchSolverWave2MoreTests } from "./sketch-solver-wave2b.test.js";
import { sketchSolverWave3Tests } from "./sketch-solver-wave3.test.js";
import { sketchSolverWave3bTests } from "./sketch-solver-wave3b.test.js";
import { operationPayloadFuzzTests } from "./operation-payload-fuzz.test.js";
import { sketchEditToolTests } from "./sketch-edit-tools.test.js";
import { sketchEditSuiteTests } from "./sketch-edit-suite.test.js";
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
import { sketchCreationFixTests } from "./sketch-creation-fixes.test.js";
import { sketchCreationCapabilityTests } from "./sketch-creation-capabilities.test.js";
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
import { pipelinePlatformTests } from "./pipeline-platform.test.js";
import { sketchTextObjectTests } from "./sketch-text-objects.test.js";
import { sketchPatternObjectTests } from "./sketch-pattern-objects.test.js";
import { sketchExchangeTests } from "./sketch-exchange.test.js";
import { sketchUnderlayTests } from "./sketch-underlay.test.js";
import { sketchExchangeUiTests } from "./sketch-exchange-ui.test.js";
import { sketchChromeTests } from "./sketch-chrome.test.js";
import { sketchCanvasUxTests } from "./sketch-canvas-ux.test.js";
import { sketchUi2EditTests } from "./sketch-ui2-edit.test.js";
import { sketchUi2InputTests } from "./sketch-ui2-input.test.js";
import { sketchUi2WorkspaceTests } from "./sketch-ui2-workspace.test.js";
import { sketchUi2CanvasTests } from "./sketch-ui2-canvas.test.js";
import { pipeline3IoTests } from "./pipeline3-io.test.js";
import { pipeline3PayloadTests } from "./pipeline3-payload.test.js";
import { pipeline3MeshTests } from "./pipeline3-mesh.test.js";
import { pipeline3TimelineTests } from "./pipeline3-timeline.test.js";
import { pipeline3UnitTests } from "./pipeline3-units.test.js";
import { pipeline3SweepPathTests } from "./pipeline3-sweep-path.test.js";
import { pipeline3PlaneTests } from "./pipeline3-plane.test.js";
import { merge3InteractionTests } from "./merge3-interactions.test.js";
import { sketchEdit3Tests, sketchEdit3RepairTests, sketchEdit3PatternTests, sketchEdit3SummaryTests } from "./sketch-edit3.test.js";
import { sketchEdit3MirrorTests } from "./sketch-edit3-mirror.test.js";
import { sketchEdit3ClipboardTests } from "./sketch-edit3-clipboard.test.js";
import { sketchEdit3RedundancyTests } from "./sketch-edit3-redundancy.test.js";
import { sketchEdit3OffsetTests } from "./sketch-edit3-offset.test.js";
import { sketchUi3DimensionTests } from "./sketch-ui3-dimensions.test.js";
import { sketchUi3ChromeTests } from "./sketch-ui3-chrome.test.js";
import { sketchUi3ErrorTests } from "./sketch-ui3-errors.test.js";
import { sketchFitInsetsTests } from "./sketch-fit-insets.test.js";
import { layoutWindowSizeTests } from "./layout-window-size.test.js";
import { sketchEntryPointTests } from "./sketch-entry-points.test.js";
import { sketchCircleDiameterTests } from "./sketch-circle-diameter.test.js";
import { sketchRectangleLevelTests } from "./sketch-rectangle-level.test.js";
import { sketchLevelPointsTests } from "./sketch-level-points.test.js";
import { sketchChainSelectTests } from "./sketch-chain-select.test.js";
import { sketchDimensionOverConstraintTests } from "./sketch-dimension-overconstraint.test.js";
import { trimJointTests } from "./trim-joints.test.js";
import { sketchDimensionPickTests } from "./sketch-dimension-pick.test.js";
import { sketchConstraintToolTests } from "./sketch-constraint-tools.test.js";
import { sketchKeysConstructionProjectTests } from "./sketch-keys-construction-project.test.js";
import { sketchCanvasHandleTests } from "./sketch-canvas-handles.test.js";
import { regionWave2Tests } from "./region-wave2.test.js";
import { regionWave3Tests } from "./region-wave3.test.js";
import type { TestCase } from "./test-kit.js";
import { sketchLineRectangleTests } from "./sketch-line-rectangle.test.js";
import { sketchReferenceLayerTests } from "./sketch-reference-layer.test.js";
import { sketchLineArcDragTests } from "./sketch-line-arc-drag.test.js";
import { sketchDiameterAcrossTests } from "./sketch-diameter-across.test.js";
import { sketchDimensionPlacementTests } from "./sketch-dimension-placement.test.js";
import { sketchFacePickTests } from "./sketch-face-pick.test.js";
import { sketchDimensionNameTests } from "./sketch-dimension-names.test.js";
import { sketchMarkingMenuTests } from "./sketch-marking-menu.test.js";
import { sketchStateColourTests } from "./sketch-state-colours.test.js";
import { sketchSlotCentrelineTests } from "./sketch-slot-centreline.test.js";
import { sketchOffsetAssociativeTests } from "./sketch-offset-associative.test.js";
import { sketchDimensionLabelTests } from "./sketch-dimension-label.test.js";
import { sketchProjectLinkedTests } from "./sketch-project-linked.test.js";
import { sketchDimensionFollowTests } from "./sketch-dimension-follow.test.js";
import { browserStepOpenTests } from "./browser-step-open.test.js";
import { timelineSelectionTests } from "./timeline-selection.test.js";
import { deleteImpactTests } from "./delete-impact.test.js";
import { deleteKeepTests } from "./delete-keep.test.js";
import { rollbackInsertTests } from "./rollback-insert.test.js";
import { timelineMenuTests } from "./timeline-menu.test.js";
import { oneUndoStepTests } from "./one-undo-step.test.js";
import { computeAllTests } from "./compute-all.test.js";
import { bodyRenameTests } from "./body-rename.test.js";
import { browserRowTests } from "./browser-rows.test.js";
import { failedBodyTests } from "./failed-body.test.js";
import { oneShotGuardTests } from "./one-shot-guard.test.js";
import { designReorderTests } from "./design-reorder.test.js";
import { typedSizeBindingTests } from "./typed-size-binding.test.js";
import { modelParameterTests } from "./model-parameters.test.js";
import { sketchesFolderTests } from "./sketches-folder.test.js";
import { timelineIconTests } from "./timeline-icons.test.js";
import { timelineGroupTests } from "./timeline-groups.test.js";
import { browserDocumentTests } from "./browser-document.test.js";
import { holeFaceNameTests } from "./hole-face-names.test.js";
import { holePlacementTests } from "./hole-placement.test.js";
import { editFeatureDockTests } from "./edit-feature-dock.test.js";
import { dockedPanelTests } from "./docked-panel.test.js";
import { holePatternFollowTests } from "./hole-pattern-follows.test.js";
import { lengthFieldDraftTests } from "./length-field-draft.test.js";
import { timelineMenuLayerTests } from "./timeline-menu-layer.test.js";
import { holeReferenceFaceTests } from "./hole-reference-faces.test.js";
import { timelineMarkerKeyTests } from "./timeline-marker-keys.test.js";
import { partSceneTests } from "./part-scenes.test.js";
import { sketchOffsetChainDefaultTests } from "./sketch-offset-chain-default.test.js";
import { sketchProjectionCurrentTests } from "./sketch-projection-current.test.js";
import { sketchDimensionPointFirstTests } from "./sketch-dimension-point-first.test.js";
import { oneShotModifierTests } from "./one-shot-modifiers.test.js";
import { blankProjectTests } from "./blank-project.test.js";
import { explicitPickTests } from "./explicit-pick.test.js";
import { viewFitTests } from "./view-fit.test.js";
import { partCreateTests } from "./part-create.test.js";
import { partHotkeyTests } from "./part-hotkeys.test.js";
import { combineStepTests } from "./combine-step.test.js";
import { ribbonHonestyTests } from "./ribbon-honesty.test.js";
import { hoverPickTests } from "./hover-pick.test.js";
import { commandPanelTests } from "./command-panel.test.js";
import { panelEnterCommitTests } from "./panel-enter-commit.test.js";
import { panelModeGuardTests } from "./panel-mode-guards.test.js";
import { holeFastenerPresetTests } from "./hole-fastener-presets.test.js";
import { operationDefaultTests } from "./operation-default.test.js";
import { featureBindingExtrasTests } from "./feature-binding-extras.test.js";
import { ribbonPanelTests } from "./ribbon-panels.test.js";
import { solidContextMenuTests } from "./solid-context-menu.test.js";

const tests: readonly TestCase[] = [
  ...modelAndCommandTests,
  ...sketchChromeTests,
  ...sketchTests,
  ...sketchRegionTests,
  ...sketchArrangementTests,
  ...sketchCameraTests,
  ...sketchInteractionTests,
  ...sketchConstraintFitTests,
  ...sketchInferenceTests,
  ...sketchDynamicInputTests,
  ...sketchInputExtrasTests,
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
  ...sketchSolverSimultaneousTests,
  ...sketchSolverDofTests,
  ...sketchSolverKindsTests,
  ...sketchEditToolTests,
  ...sketchEditSuiteTests,
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
  ...sketchCreationFixTests,
  ...sketchCreationCapabilityTests,
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
  ...pipelinePlatformTests,
  ...sketchTextObjectTests,
  ...sketchPatternObjectTests,
  ...sketchExchangeTests,
  ...sketchUnderlayTests,
  ...sketchExchangeUiTests,
  ...sketchCanvasUxTests,
  ...sketchCanvasHandleTests,
  ...regionWave2Tests,
  ...regionWave3Tests,
  ...sketchSolverWave2Tests,
  ...sketchSolverWave2MoreTests,
  ...sketchSolverWave3Tests,
  ...sketchSolverWave3bTests,
  ...operationPayloadFuzzTests,
  ...sketchShapeJointTests,
  ...sketchArcSlotJointTests,
  ...sketchRegularPolygonTests,
  ...sketchCornerJoinTests,
  ...sketchDrawInferenceTests,
  ...sketchUi2EditTests,
  ...sketchUi2InputTests,
  ...sketchUi2WorkspaceTests,
  ...sketchUi2CanvasTests,
  ...pipeline3IoTests,
  ...pipeline3PayloadTests,
  ...pipeline3MeshTests,
  ...pipeline3TimelineTests,
  ...pipeline3UnitTests,
  ...pipeline3SweepPathTests,
  ...pipeline3PlaneTests,
  ...sketchEdit3Tests,
  ...sketchEdit3RepairTests,
  ...sketchEdit3PatternTests,
  ...sketchEdit3SummaryTests,
  ...sketchEdit3MirrorTests,
  ...sketchEdit3ClipboardTests,
  ...sketchEdit3RedundancyTests,
  ...sketchEdit3OffsetTests,
  ...merge3InteractionTests,
  ...sketchShapes3Tests,
  ...sketchArcSlots3Tests,
  ...sketchSnapRelations3Tests,
  ...sketchEllipseCrossing3Tests,
  ...sketchTypedEntry3Tests,
  ...sketchShapeSnaps3Tests,
  ...sketchBuilderGuards3Tests,
  ...sketchSpline3Tests,
  ...sketchHotkeys3Tests,
  ...sketchFit3Tests,
  ...sketchEveryShape3Tests,
  ...sketchUi3DimensionTests,
  ...sketchUi3ChromeTests,
  ...sketchUi3ErrorTests,
  ...sketchFitInsetsTests,
  ...layoutWindowSizeTests,
  ...sketchEntryPointTests,
  ...sketchCircleDiameterTests,
  ...sketchRectangleLevelTests,
  ...sketchLevelPointsTests,
  ...sketchChainSelectTests,
  ...sketchDimensionOverConstraintTests,
  ...trimJointTests,
  ...sketchDimensionPickTests,
  ...sketchConstraintToolTests,
  ...sketchKeysConstructionProjectTests,
  ...sketchLineRectangleTests,
  ...sketchReferenceLayerTests,
  ...sketchLineArcDragTests,
  ...sketchDiameterAcrossTests,
  ...sketchDimensionPlacementTests,
  ...sketchFacePickTests,
  ...sketchDimensionNameTests,
  ...sketchMarkingMenuTests,
  ...sketchStateColourTests,
  ...sketchSlotCentrelineTests,
  ...sketchOffsetAssociativeTests,
  ...sketchDimensionLabelTests,
  ...sketchProjectLinkedTests,
  ...sketchDimensionFollowTests,
  ...browserStepOpenTests,
  ...sketchOffsetChainDefaultTests,
  ...sketchProjectionCurrentTests,
  ...sketchDimensionPointFirstTests,
  ...oneShotModifierTests,
  ...blankProjectTests,
  ...explicitPickTests,
  ...viewFitTests,
  ...partCreateTests,
  ...partHotkeyTests,
  ...combineStepTests,
  ...ribbonHonestyTests,
  ...hoverPickTests,
  ...commandPanelTests,
  ...panelEnterCommitTests,
  ...panelModeGuardTests,
  ...holeFastenerPresetTests,
  ...operationDefaultTests,
  ...featureBindingExtrasTests,
  ...ribbonPanelTests,
  ...solidContextMenuTests,
  ...timelineSelectionTests,
  ...deleteImpactTests,
  ...deleteKeepTests,
  ...rollbackInsertTests,
  ...timelineMenuTests,
  ...oneUndoStepTests,
  ...computeAllTests,
  ...bodyRenameTests,
  ...browserRowTests,
  ...failedBodyTests,
  ...oneShotGuardTests,
  ...designReorderTests,
  ...typedSizeBindingTests,
  ...modelParameterTests,
  ...sketchesFolderTests,
  ...timelineIconTests,
  ...timelineGroupTests,
  ...browserDocumentTests,
  ...holeFaceNameTests,
  ...holePlacementTests,
  ...editFeatureDockTests,
  ...dockedPanelTests,
  ...holePatternFollowTests,
  ...lengthFieldDraftTests,
  ...timelineMenuLayerTests,
  ...holeReferenceFaceTests,
  ...timelineMarkerKeyTests,
  ...partSceneTests,
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
