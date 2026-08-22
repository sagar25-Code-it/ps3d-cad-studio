import {
  ELECTRICAL_SHEET_BOUNDS,
  ELECTRICAL_SHEET_RESERVED_REGIONS,
  electricalComponentSheetFootprint,
  type ElectricalComponent,
  type ElectricalIntent,
  type ElectricalNet,
  type Vec2
} from "./types.js";

export interface ElectricalSheetSegment {
  readonly start: Vec2;
  readonly end: Vec2;
}

export interface ElectricalSheetRoute {
  readonly netId: string;
  readonly path: string;
  readonly label: Vec2;
  readonly segments: readonly ElectricalSheetSegment[];
}

export interface ElectricalRoutePlan {
  readonly routes: readonly ElectricalSheetRoute[];
  readonly blockedNetIds: readonly string[];
  readonly budgetExceededNetIds: readonly string[];
  readonly workUnits: number;
  readonly workBudget: number;
}

interface SheetObstacle {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly componentId?: string;
}

interface RoutedTerminal {
  readonly componentId: string;
  readonly pin: Vec2;
  readonly escape: Vec2;
}

interface RouteCandidate {
  readonly path: string;
  readonly label: Vec2;
  readonly segments: readonly ElectricalSheetSegment[];
  readonly occupiedSegments: readonly ElectricalSheetSegment[];
}

interface RoutingBudget {
  remaining: number;
  exhausted: boolean;
}

const COMPONENT_CLEARANCE = 8;
const WIRE_CLEARANCE = 5;
const MAX_PRIMARY_CORRIDORS = 48;
const MAX_EXTENDED_CORRIDORS = 24;

export const ELECTRICAL_ROUTING_WORK_BUDGET = 250_000;

export function createElectricalRoutePlan(intent: ElectricalIntent, requestedWorkBudget = ELECTRICAL_ROUTING_WORK_BUDGET): ElectricalRoutePlan {
  const workBudget = Number.isFinite(requestedWorkBudget)
    ? Math.min(ELECTRICAL_ROUTING_WORK_BUDGET, Math.max(0, Math.floor(requestedWorkBudget)))
    : ELECTRICAL_ROUTING_WORK_BUDGET;
  const budget: RoutingBudget = { remaining: workBudget, exhausted: workBudget === 0 };
  const byId = new Map(intent.components.map((component) => [component.id, component]));
  const componentObstacles: SheetObstacle[] = intent.components.map((component) => {
    const footprint = electricalComponentSheetFootprint(component.position, component.rotationDeg);
    return {
      minX: footprint.minX - COMPONENT_CLEARANCE,
      maxX: footprint.maxX + COMPONENT_CLEARANCE,
      minY: footprint.minY - COMPONENT_CLEARANCE,
      maxY: footprint.maxY + COMPONENT_CLEARANCE,
      componentId: component.id
    };
  });
  const componentObstacleById = new Map(componentObstacles.map((obstacle) => [obstacle.componentId!, obstacle]));
  const fixedObstacles: SheetObstacle[] = ELECTRICAL_SHEET_RESERVED_REGIONS.map((region) => ({ ...region }));
  const occupied: SheetObstacle[] = [];
  const routes: ElectricalSheetRoute[] = [];
  const blockedNetIds: string[] = [];
  const blockedNetIdSet = new Set<string>();
  const budgetExceededNetIds: string[] = [];
  const budgetExceededNetIdSet = new Set<string>();

  const blockNet = (netId: string, budgetExceeded = false): void => {
    if (!blockedNetIdSet.has(netId)) {
      blockedNetIdSet.add(netId);
      blockedNetIds.push(netId);
    }
    if (budgetExceeded && !budgetExceededNetIdSet.has(netId)) {
      budgetExceededNetIdSet.add(netId);
      budgetExceededNetIds.push(netId);
    }
  };

  const routingOrder = intent.nets.map((net, index) => ({ net, index })).sort((left, right) => netPriority(left.net.class) - netPriority(right.net.class) || left.index - right.index);
  for (let routingIndex = 0; routingIndex < routingOrder.length; routingIndex += 1) {
    const net = routingOrder[routingIndex]!.net;
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      for (const pending of routingOrder.slice(routingIndex)) blockNet(pending.net.id, true);
      break;
    }
    const terminals = net.endpoints.map((endpoint) => {
      const component = byId.get(endpoint.componentId);
      const ownObstacle = componentObstacleById.get(endpoint.componentId);
      return component === undefined || ownObstacle === undefined ? undefined : routedTerminal(component, endpoint.terminal, ownObstacle);
    }).filter((terminal): terminal is RoutedTerminal => terminal !== undefined);
    const obstacles = [...fixedObstacles, ...componentObstacles, ...occupied];
    if (terminals.length !== net.endpoints.length || terminals.length < 2 || terminals.some((terminal) => !portalIsClear(terminal, obstacles, budget))) {
      blockNet(net.id, budget.exhausted);
      continue;
    }
    const candidate = terminals.length === 2 ? routePair(terminals as [RoutedTerminal, RoutedTerminal], obstacles, budget) : routeBus(terminals, obstacles, budget);
    if (candidate === undefined) {
      blockNet(net.id, budget.exhausted);
      continue;
    }
    routes.push({ netId: net.id, path: candidate.path, label: candidate.label, segments: candidate.segments });
    occupied.push(...candidate.occupiedSegments.map((segment) => segmentObstacle(segment, WIRE_CLEARANCE)), labelObstacle(candidate.label));
  }
  return { routes, blockedNetIds, budgetExceededNetIds, workUnits: workBudget - budget.remaining, workBudget };
}

function netPriority(netClass: ElectricalNet["class"]): number {
  if (netClass === "ground") return 0;
  if (netClass === "power-dc") return 1;
  if (netClass === "power-ac") return 2;
  return 3;
}

function routedTerminal(component: ElectricalComponent, terminal: string, own: SheetObstacle): RoutedTerminal | undefined {
  if (!component.terminals.includes(terminal)) return undefined;
  const local = terminalLocalPoint(component, terminal);
  const direction = terminalLocalDirection(component, terminal);
  const angle = component.rotationDeg * Math.PI / 180;
  const pin = rotateAndTranslate(local, component.position, angle);
  const unitDirection: Vec2 = [direction[0] * Math.cos(angle) - direction[1] * Math.sin(angle), direction[0] * Math.sin(angle) + direction[1] * Math.cos(angle)];
  for (let distance = 8; distance <= 240; distance += 4) {
    const probe: Vec2 = [pin[0] + unitDirection[0] * distance, pin[1] + unitDirection[1] * distance];
    if (!pointInside(probe, own)) {
      const escape: Vec2 = roundPoint(probe);
      return pointWithinSheet(escape) ? { componentId: component.id, pin: roundPoint(pin), escape } : undefined;
    }
  }
  return undefined;
}

function terminalLocalPoint(component: ElectricalComponent, terminal: string): Vec2 {
  if (component.kind === "ground") return [0, -48];
  if (component.terminals.length === 1) return [-55, 0];
  const index = component.terminals.indexOf(terminal);
  if (index <= 0) return [-55, 0];
  if (index === 1) return [55, 0];
  return [0, 50 + (index - 2) * 12];
}

function terminalLocalDirection(component: ElectricalComponent, terminal: string): Vec2 {
  if (component.kind === "ground") return [0, -1];
  if (component.terminals.length === 1) return [-1, 0];
  const index = component.terminals.indexOf(terminal);
  if (index <= 0) return [-1, 0];
  if (index === 1) return [1, 0];
  return [0, 1];
}

function rotateAndTranslate(local: Vec2, position: Vec2, angle: number): Vec2 {
  return [position[0] + local[0] * Math.cos(angle) - local[1] * Math.sin(angle), position[1] + local[0] * Math.sin(angle) + local[1] * Math.cos(angle)];
}

function portalIsClear(terminal: RoutedTerminal, obstacles: readonly SheetObstacle[], budget: RoutingBudget): boolean {
  if (!segmentWithinSheet(terminal.pin, terminal.escape)) return false;
  return unrestrictedSegmentIsClear(terminal.pin, terminal.escape, obstacles, budget, terminal.componentId);
}

function routePair([a, b]: readonly [RoutedTerminal, RoutedTerminal], obstacles: readonly SheetObstacle[], budget: RoutingBudget): RouteCandidate | undefined {
  const midpointX = (a.escape[0] + b.escape[0]) / 2;
  const midpointY = (a.escape[1] + b.escape[1]) / 2;
  const corridorYs = nearestCorridors(uniqueNumbers([
    midpointY,
    ...obstacles.flatMap((region) => [region.minY - 18, region.maxY + 30]),
    ELECTRICAL_SHEET_BOUNDS.minY + 24,
    ELECTRICAL_SHEET_BOUNDS.maxY - 46
  ]).filter((value) => value >= ELECTRICAL_SHEET_BOUNDS.minY && value <= ELECTRICAL_SHEET_BOUNDS.maxY), [a.escape[1], b.escape[1], midpointY], MAX_PRIMARY_CORRIDORS);
  const corridorXs = nearestCorridors(uniqueNumbers([
    midpointX,
    ...obstacles.flatMap((region) => [region.minX - 18, region.maxX + 18]),
    ELECTRICAL_SHEET_BOUNDS.minX + 24,
    ELECTRICAL_SHEET_BOUNDS.maxX - 24
  ]).filter((value) => value >= ELECTRICAL_SHEET_BOUNDS.minX && value <= ELECTRICAL_SHEET_BOUNDS.maxX), [a.escape[0], b.escape[0], midpointX], MAX_PRIMARY_CORRIDORS);
  const candidates: Vec2[][] = [
    [a.escape, [midpointX, a.escape[1]], [midpointX, b.escape[1]], b.escape],
    [a.escape, [a.escape[0], midpointY], [b.escape[0], midpointY], b.escape],
    ...corridorYs.map((y) => [a.escape, [a.escape[0], y] as Vec2, [b.escape[0], y] as Vec2, b.escape]),
    ...corridorXs.map((x) => [a.escape, [x, a.escape[1]] as Vec2, [x, b.escape[1]] as Vec2, b.escape])
  ];
  let selected = selectRouteCandidate(candidates, obstacles, budget);
  if (selected === undefined && !budget.exhausted) {
    const searchXs = nearestCorridors(corridorXs, [a.escape[0], b.escape[0], midpointX], MAX_EXTENDED_CORRIDORS);
    const searchYs = nearestCorridors(corridorYs, [a.escape[1], b.escape[1], midpointY], MAX_EXTENDED_CORRIDORS);
    const extended: Vec2[][] = [];
    for (const x of searchXs) for (const y of searchYs) {
      extended.push(
        [a.escape, [a.escape[0], y], [x, y], [x, b.escape[1]], b.escape],
        [a.escape, [x, a.escape[1]], [x, y], [b.escape[0], y], b.escape]
      );
    }
    selected = selectRouteCandidate(extended, obstacles, budget);
  }
  if (selected === undefined) return undefined;
  const fullPoints = normalizePoints([a.pin, a.escape, ...selected.slice(1, -1), b.escape, b.pin]);
  return {
    path: pointsToPath(fullPoints),
    label: routeLabel(selected),
    segments: pointsToSegments(fullPoints),
    occupiedSegments: pointsToSegments(fullPoints)
  };
}

function selectRouteCandidate(candidates: readonly (readonly Vec2[])[], obstacles: readonly SheetObstacle[], budget: RoutingBudget): Vec2[] | undefined {
  let selected: Vec2[] | undefined;
  let selectedScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (budget.exhausted) break;
    const points = normalizePoints(candidate);
    if (!routeIsClear(points, obstacles, budget) || !labelIsClear(routeLabel(points), obstacles, budget)) continue;
    const score = routeScore(points);
    if (score < selectedScore) {
      selected = points;
      selectedScore = score;
    }
  }
  return selected;
}

function nearestCorridors(values: readonly number[], anchors: readonly number[], limit: number): number[] {
  return [...values].sort((left, right) => Math.min(...anchors.map((anchor) => Math.abs(left - anchor))) - Math.min(...anchors.map((anchor) => Math.abs(right - anchor))) || left - right).slice(0, limit);
}

function routeBus(terminals: readonly RoutedTerminal[], obstacles: readonly SheetObstacle[], budget: RoutingBudget): RouteCandidate | undefined {
  const escapes = terminals.map((terminal) => terminal.escape);
  const target = Math.max(...escapes.map((point) => point[1])) - 18;
  const minimumEscapeY = Math.min(...escapes.map((point) => point[1]));
  const maximumEscapeY = Math.max(...escapes.map((point) => point[1]));
  const corridorYs = nearestCorridors(uniqueNumbers([
    target,
    ...escapes.map((point) => point[1]),
    ...obstacles.flatMap((region) => [region.minY - 18, region.maxY + 30]),
    ELECTRICAL_SHEET_BOUNDS.minY + 24,
    ELECTRICAL_SHEET_BOUNDS.maxY - 46
  ]).filter((value) => value >= ELECTRICAL_SHEET_BOUNDS.minY && value <= ELECTRICAL_SHEET_BOUNDS.maxY), [target, minimumEscapeY, maximumEscapeY], MAX_PRIMARY_CORRIDORS);
  const minX = Math.min(...escapes.map((point) => point[0]));
  const maxX = Math.max(...escapes.map((point) => point[0]));
  let selectedBus: { readonly busY: number; readonly label: Vec2 } | undefined;
  let selectedDistance = Number.POSITIVE_INFINITY;
  for (const candidate of corridorYs) {
    if (budget.exhausted) break;
    const segments = [{ start: [minX, candidate] as Vec2, end: [maxX, candidate] as Vec2 }, ...escapes.map((point) => ({ start: point, end: [point[0], candidate] as Vec2 }))];
    if (!segmentsAreClear(segments, obstacles, budget)) continue;
    const label = findClearBusLabel(minX, maxX, candidate, obstacles, budget);
    const distance = Math.abs(candidate - target);
    if (label !== undefined && distance < selectedDistance) {
      selectedBus = { busY: candidate, label };
      selectedDistance = distance;
    }
  }
  if (selectedBus === undefined) return undefined;
  const { busY, label } = selectedBus;
  const internalSegments: ElectricalSheetSegment[] = [
    { start: [minX, busY], end: [maxX, busY] },
    ...escapes.map((point) => ({ start: point, end: [point[0], busY] as Vec2 }))
  ];
  const portalSegments = terminals.map((terminal) => ({ start: terminal.pin, end: terminal.escape }));
  return {
    path: `${internalSegments.map((segment) => segmentToPath(segment)).join(" ")} ${portalSegments.map((segment) => segmentToPath(segment)).join(" ")}`.trim(),
    label,
    segments: [...internalSegments, ...portalSegments],
    occupiedSegments: [...internalSegments, ...portalSegments]
  };
}

function findClearBusLabel(minX: number, maxX: number, busY: number, obstacles: readonly SheetObstacle[], budget: RoutingBudget): Vec2 | undefined {
  const minimumCenter = minX + 90;
  const maximumCenter = maxX - 90;
  if (minimumCenter > maximumCenter) return undefined;
  const candidates = uniqueNumbers([(minX + maxX) / 2, minimumCenter, maximumCenter, ...Array.from({ length: 9 }, (_, index) => minimumCenter + (maximumCenter - minimumCenter) * index / 8)]);
  for (const x of candidates) {
    const label: Vec2 = [x, busY - 10];
    if (labelIsClear(label, obstacles, budget)) return label;
    if (budget.exhausted) break;
  }
  return undefined;
}

function routeIsClear(points: readonly Vec2[], obstacles: readonly SheetObstacle[], budget: RoutingBudget): boolean {
  return points.every(pointWithinSheet) && segmentsAreClear(pointsToSegments(points), obstacles, budget);
}

function segmentsAreClear(segments: readonly ElectricalSheetSegment[], obstacles: readonly SheetObstacle[], budget: RoutingBudget): boolean {
  for (const segment of segments) {
    if (!segmentWithinSheet(segment.start, segment.end) || !segmentIsClear(segment.start, segment.end, obstacles, budget)) return false;
  }
  return true;
}

function segmentIsClear(start: Vec2, end: Vec2, obstacles: readonly SheetObstacle[], budget: RoutingBudget): boolean {
  if (!approximatelyEqual(start[0], end[0]) && !approximatelyEqual(start[1], end[1])) return false;
  for (const region of obstacles) {
    if (!consumeWork(budget)) return false;
    if (approximatelyEqual(start[1], end[1])) {
      const minX = Math.min(start[0], end[0]);
      const maxX = Math.max(start[0], end[0]);
      if (start[1] >= region.minY && start[1] <= region.maxY && maxX >= region.minX && minX <= region.maxX) return false;
      continue;
    }
    const minY = Math.min(start[1], end[1]);
    const maxY = Math.max(start[1], end[1]);
    if (start[0] >= region.minX && start[0] <= region.maxX && maxY >= region.minY && minY <= region.maxY) return false;
  }
  return true;
}

function unrestrictedSegmentIsClear(start: Vec2, end: Vec2, obstacles: readonly SheetObstacle[], budget: RoutingBudget, ignoredComponentId?: string): boolean {
  for (const obstacle of obstacles) {
    if (obstacle.componentId === ignoredComponentId) continue;
    if (!consumeWork(budget) || segmentIntersectsRectangle(start, end, obstacle)) return false;
  }
  return true;
}

function segmentIntersectsRectangle(start: Vec2, end: Vec2, rectangle: SheetObstacle): boolean {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  let minimum = 0;
  let maximum = 1;
  const boundaries: readonly [number, number][] = [
    [-dx, start[0] - rectangle.minX],
    [dx, rectangle.maxX - start[0]],
    [-dy, start[1] - rectangle.minY],
    [dy, rectangle.maxY - start[1]]
  ];
  for (const [direction, distance] of boundaries) {
    if (approximatelyEqual(direction, 0)) {
      if (distance < 0) return false;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  return true;
}

function segmentWithinSheet(start: Vec2, end: Vec2): boolean {
  return pointWithinSheet(start) && pointWithinSheet(end);
}

function pointWithinSheet(point: Vec2): boolean {
  return point[0] >= ELECTRICAL_SHEET_BOUNDS.minX && point[0] <= ELECTRICAL_SHEET_BOUNDS.maxX
    && point[1] >= ELECTRICAL_SHEET_BOUNDS.minY && point[1] <= ELECTRICAL_SHEET_BOUNDS.maxY;
}

function pointInside(point: Vec2, obstacle: SheetObstacle): boolean {
  return point[0] >= obstacle.minX && point[0] <= obstacle.maxX && point[1] >= obstacle.minY && point[1] <= obstacle.maxY;
}

function labelIsClear(label: Vec2, obstacles: readonly SheetObstacle[], budget: RoutingBudget): boolean {
  const footprint = labelObstacle(label);
  if (footprint.minX < ELECTRICAL_SHEET_BOUNDS.minX || footprint.maxX > ELECTRICAL_SHEET_BOUNDS.maxX
    || footprint.minY < ELECTRICAL_SHEET_BOUNDS.minY || footprint.maxY > ELECTRICAL_SHEET_BOUNDS.maxY) return false;
  for (const region of obstacles) {
    if (!consumeWork(budget) || rectanglesOverlap(footprint, region)) return false;
  }
  return true;
}

function consumeWork(budget: RoutingBudget): boolean {
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= 1;
  return true;
}

function labelObstacle(label: Vec2): SheetObstacle {
  return { minX: label[0] - 90, maxX: label[0] + 90, minY: label[1] - 13, maxY: label[1] + 4 };
}

function segmentObstacle(segment: ElectricalSheetSegment, clearance: number): SheetObstacle {
  return {
    minX: Math.min(segment.start[0], segment.end[0]) - clearance,
    maxX: Math.max(segment.start[0], segment.end[0]) + clearance,
    minY: Math.min(segment.start[1], segment.end[1]) - clearance,
    maxY: Math.max(segment.start[1], segment.end[1]) + clearance
  };
}

function rectanglesOverlap(left: SheetObstacle, right: SheetObstacle): boolean {
  return left.maxX >= right.minX && left.minX <= right.maxX && left.maxY >= right.minY && left.minY <= right.maxY;
}

function normalizePoints(points: readonly Vec2[]): Vec2[] {
  return points.map(roundPoint).filter((point, index, values) => index === 0 || !samePoint(point, values[index - 1]!));
}

function pointsToSegments(points: readonly Vec2[]): ElectricalSheetSegment[] {
  return points.slice(1).map((point, index) => ({ start: points[index]!, end: point })).filter((segment) => !samePoint(segment.start, segment.end));
}

function routeScore(points: readonly Vec2[]): number {
  return pointsToSegments(points).reduce((total, segment) => total + Math.abs(segment.end[0] - segment.start[0]) + Math.abs(segment.end[1] - segment.start[1]), 0) + Math.max(0, points.length - 2) * 4;
}

function pointsToPath(points: readonly Vec2[]): string {
  return points.slice(1).reduce((path, point, index) => `${path} ${pathCommand(points[index]!, point)}`, `M ${formatNumber(points[0]![0])} ${formatNumber(points[0]![1])}`);
}

function segmentToPath(segment: ElectricalSheetSegment): string {
  return `M ${formatNumber(segment.start[0])} ${formatNumber(segment.start[1])} ${pathCommand(segment.start, segment.end)}`;
}

function pathCommand(start: Vec2, end: Vec2): string {
  if (approximatelyEqual(start[1], end[1])) return `H ${formatNumber(end[0])}`;
  if (approximatelyEqual(start[0], end[0])) return `V ${formatNumber(end[1])}`;
  return `L ${formatNumber(end[0])} ${formatNumber(end[1])}`;
}

function routeLabel(points: readonly Vec2[]): Vec2 {
  const horizontal = pointsToSegments(points).filter((segment) => approximatelyEqual(segment.start[1], segment.end[1])).sort((left, right) => Math.abs(right.end[0] - right.start[0]) - Math.abs(left.end[0] - left.start[0]))[0];
  return horizontal === undefined
    ? roundPoint([(points[0]![0] + points.at(-1)![0]) / 2, Math.min(points[0]![1], points.at(-1)![1]) - 10])
    : roundPoint([(horizontal.start[0] + horizontal.end[0]) / 2, horizontal.start[1] - 10]);
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value * 1_000) / 1_000))];
}

function roundPoint(point: Vec2): Vec2 {
  return [Math.round(point[0] * 1_000) / 1_000, Math.round(point[1] * 1_000) / 1_000];
}

function samePoint(left: Vec2, right: Vec2): boolean {
  return approximatelyEqual(left[0], right[0]) && approximatelyEqual(left[1], right[1]);
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.000_5;
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1_000) / 1_000);
}
