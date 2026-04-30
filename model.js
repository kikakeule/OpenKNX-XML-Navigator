const ELEMENT_NODE = 1;
const TRANSLATABLE_ATTRIBUTES = new Set(["FunctionText", "Name", "SuffixText", "Text"]);
const translationMapsByDocument = new WeakMap();

export function buildSimulatorModel(xmlText, options = {}) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "application/xml");
  const parserError = xml.getElementsByTagName("parsererror")[0];
  if (parserError) {
    throw new Error(parserError.textContent.trim());
  }

  const appNode = firstByPath(xml.documentElement, [
    "ManufacturerData",
    "Manufacturer",
    "ApplicationPrograms",
    "ApplicationProgram",
  ]);

  if (!appNode) {
    throw new Error("ApplicationProgram wurde in der XML nicht gefunden.");
  }

  const defaultLanguage = appNode.getAttribute("DefaultLanguage") || "de";
  const selectedLanguage = String(options.language || defaultLanguage).trim();
  translationMapsByDocument.set(xml, buildTranslationMap(appNode, selectedLanguage));

  const staticNode = childByName(appNode, "Static");
  const dynamicNode = childByName(appNode, "Dynamic");
  if (!staticNode || !dynamicNode) {
    throw new Error("Static oder Dynamic fehlt in der XML.");
  }

  const context = {
    comObjectRefs: new Map(),
    comObjects: new Map(),
    moduleDefinitions: new Map(),
    moduleInstances: new Set(),
    nodeIndex: new Map(),
    parameterRefs: new Map(),
    parameters: new Map(),
    parameterTypes: new Map(),
    stats: {
      channels: 0,
      parameterBlocks: 0,
      parameters: 0,
    },
    unsupportedDynamicElements: new Set(),
  };

  parseParameterTypes(staticNode, context);
  parseParameters(staticNode, context);
  parseParameterRefs(staticNode, context);
  parseComObjects(staticNode, context);
  parseComObjectRefs(staticNode, context);
  parseModuleDefinitions(appNode, context);

  const roots = parseDynamicChildren(dynamicNode, context);
  const initialState = Object.create(null);
  for (const parameterRef of context.parameterRefs.values()) {
    const parameter = context.parameters.get(parameterRef.refId);
    if (parameter) {
      initialState[parameterRef.id] = parameter.value;
    }
  }

  const navigation = buildNavigationEntries(roots);

  const warnings = [];
  if (hasDescendant(staticNode, "Script")) {
    warnings.push("Skript-Bloecke werden erkannt, aber in dieser Version nicht ausgefuehrt.");
  }
  if (hasDescendant(staticNode, "ParameterCalculation")) {
    warnings.push("ParameterCalculation mit JavaScript wird angezeigt, aber nicht simuliert.");
  }
  if (context.unsupportedDynamicElements.size > 0) {
    warnings.push(
      `Einige Dynamic-Elemente wurden uebersprungen: ${Array.from(context.unsupportedDynamicElements)
        .sort()
        .join(", ")}.`
    );
  }

  return {
    initialState,
    metadata: {
      applicationId: attr(appNode, "Id"),
      applicationNumber: attr(appNode, "ApplicationNumber"),
      applicationVersion: attr(appNode, "ApplicationVersion"),
      defaultLanguage,
      name: attr(appNode, "Name", "ApplicationProgram"),
      programType: attr(appNode, "ProgramType"),
      selectedLanguage,
    },
    navigation,
    nodeIndex: context.nodeIndex,
    roots,
    stats: context.stats,
    warnings,
  };
}

export function deriveRuntimeState(model, userState) {
  const derivedState = { ...model.initialState, ...userState };

  for (let pass = 0; pass < 10; pass += 1) {
    const changed = applyAssignments(model.roots, derivedState);
    if (!changed) {
      break;
    }
  }

  return derivedState;
}

export function materializeNode(node, runtimeState) {
  if (!node) {
    return null;
  }

  if (!node.children || node.children.length === 0) {
    return { ...node, visibleChildren: [] };
  }

  const visibleChildren = materializeNodes(node.children, runtimeState);
  return {
    ...node,
    visibleChildren,
  };
}

export function materializeNodes(nodes, runtimeState) {
  const materialized = [];

  for (const node of nodes) {
    if (node.kind === "choose") {
      for (const branch of resolveActiveChooseBranches(node, runtimeState)) {
        materialized.push(...materializeNodes(branch.children, runtimeState));
      }
      continue;
    }

    if (node.kind === "assign" || node.kind === "rename") {
      continue;
    }

    materialized.push(materializeNode(node, runtimeState));
  }

  return materialized;
}

export function resolveTitle(node, runtimeState) {
  if (!node) {
    return "";
  }

  const renamedTitle = runtimeState[`__rename__${node.id}`];
  if (renamedTitle) {
    return resolveTemplateText(renamedTitle, node.textParameterRefId, runtimeState);
  }

  let title = "";

  if (node.kind === "parameterBlock" && !node.rawText) {
    title = node.parameter?.text || node.parameter?.name || "";
  }

  return resolveTemplateText(title || node.text || node.name || node.number || node.id, node.textParameterRefId, runtimeState);
}

export function resolveNodePath(model, nodeId) {
  const path = [];

  function walk(nodes, ancestors) {
    for (const node of nodes) {
      const nextAncestors = [...ancestors, node];
      if (node.id === nodeId) {
        path.push(...nextAncestors);
        return true;
      }
      if (node.children && walk(node.children, nextAncestors)) {
        return true;
      }
    }
    return false;
  }

  walk(model.roots, []);
  return path;
}

export function resolveBreadcrumbs(model, nodeId, runtimeState) {
  return resolveNodePath(model, nodeId).map((node) => resolveTitle(node, runtimeState));
}

export function describeField(node, runtimeState) {
  const parameter = node.parameter;
  const parameterType = node.parameterType;
  const value = runtimeState[node.paramRefId] ?? parameter?.value ?? "";
  const name = parameter?.name || node.aliasName || "Parameter";

  return {
    access: parameter?.access || "ReadWrite",
    hint: parameter?.helpContext || node.helpContext || "",
    name,
    suffixText: parameter?.suffixText || "",
    text: parameter?.text || name,
    type: parameterType,
    value,
  };
}

export function describeObject(node, runtimeState) {
  const comObjectRef = node.comObjectRef;
  const comObject = node.comObject;
  return {
    communicationFlag: resolveObjectFlag(comObjectRef?.communicationFlag, comObject?.communicationFlag),
    datapointType: comObject?.datapointType || "",
    functionText: comObject?.functionText || comObjectRef?.functionText || "",
    helpContext: node.helpContext || "",
    name: comObject?.name || comObjectRef?.name || "Kommunikationsobjekt",
    number: comObject?.number || "",
    objectSize: comObject?.objectSize || "",
    priority: comObject?.priority || "Low",
    readFlag: resolveObjectFlag(comObjectRef?.readFlag, comObject?.readFlag),
    readOnInitFlag: resolveObjectFlag(comObjectRef?.readOnInitFlag, comObject?.readOnInitFlag),
    text: resolveTemplateText(comObjectRef?.text || comObject?.text || node.text || "", comObjectRef?.textParameterRefId, runtimeState),
    transmitFlag: resolveObjectFlag(comObjectRef?.transmitFlag, comObject?.transmitFlag),
    updateFlag: resolveObjectFlag(comObjectRef?.updateFlag, comObject?.updateFlag),
    writeFlag: resolveObjectFlag(comObjectRef?.writeFlag, comObject?.writeFlag),
  };
}

function resolveObjectFlag(primaryValue, fallbackValue) {
  return primaryValue || fallbackValue || "Disabled";
}

function parseParameterTypes(staticNode, context) {
  const parameterTypesNode = childByName(staticNode, "ParameterTypes");
  if (!parameterTypesNode) {
    return;
  }

  for (const parameterTypeNode of childElements(parameterTypesNode, "ParameterType")) {
    const definitionNode = firstElementChild(parameterTypeNode);
    const enumerations = [];
    if (definitionNode && localName(definitionNode) === "TypeRestriction") {
      for (const enumerationNode of childElements(definitionNode, "Enumeration")) {
        enumerations.push({
          icon: attr(enumerationNode, "Icon"),
          text: attr(enumerationNode, "Text"),
          value: attr(enumerationNode, "Value"),
        });
      }
    }

    context.parameterTypes.set(attr(parameterTypeNode, "Id"), {
      base: definitionNode ? attr(definitionNode, "Base") : "",
      enumerations,
      id: attr(parameterTypeNode, "Id"),
      name: attr(parameterTypeNode, "Name"),
      pictureAlignment: definitionNode ? attr(definitionNode, "HorizontalAlignment") : "",
      pictureRefId: definitionNode ? attr(definitionNode, "RefId") : "",
      sizeInBit: definitionNode ? attr(definitionNode, "SizeInBit") : "",
      type: definitionNode ? localName(definitionNode) : "",
      uiHint: definitionNode ? attr(definitionNode, "UIHint") : "",
      valueType: definitionNode ? attr(definitionNode, "Type") : "",
      maxInclusive: definitionNode ? attr(definitionNode, "maxInclusive") : "",
      minInclusive: definitionNode ? attr(definitionNode, "minInclusive") : "",
      increment: definitionNode ? attr(definitionNode, "Increment") : "",
    });
  }
}

function parseParameters(staticNode, context) {
  const parametersNode = childByName(staticNode, "Parameters");
  if (!parametersNode) {
    return;
  }

  walkElements(parametersNode, (parameterNode) => {
    if (localName(parameterNode) !== "Parameter") {
      return;
    }

    context.parameters.set(attr(parameterNode, "Id"), {
      access: attr(parameterNode, "Access"),
      helpContext: attr(parameterNode, "HelpContext"),
      id: attr(parameterNode, "Id"),
      name: attr(parameterNode, "Name"),
      parameterTypeId: attr(parameterNode, "ParameterType"),
      suffixText: attr(parameterNode, "SuffixText"),
      text: attr(parameterNode, "Text"),
      value: attr(parameterNode, "Value"),
    });
    context.stats.parameters += 1;
  });
}

function parseParameterRefs(staticNode, context) {
  const parameterRefsNode = childByName(staticNode, "ParameterRefs");
  if (!parameterRefsNode) {
    return;
  }

  walkElements(parameterRefsNode, (parameterRefNode) => {
    if (localName(parameterRefNode) !== "ParameterRef") {
      return;
    }

    context.parameterRefs.set(attr(parameterRefNode, "Id"), {
      id: attr(parameterRefNode, "Id"),
      refId: attr(parameterRefNode, "RefId"),
    });
  });
}

function parseComObjects(staticNode, context) {
  const comObjectTableNode = childByName(staticNode, "ComObjectTable");
  if (!comObjectTableNode) {
    return;
  }

  walkElements(comObjectTableNode, (comObjectNode) => {
    if (localName(comObjectNode) !== "ComObject") {
      return;
    }

    context.comObjects.set(attr(comObjectNode, "Id"), {
      communicationFlag: attr(comObjectNode, "CommunicationFlag"),
      datapointType: attr(comObjectNode, "DatapointType"),
      functionText: attr(comObjectNode, "FunctionText"),
      id: attr(comObjectNode, "Id"),
      name: attr(comObjectNode, "Name"),
      number: attr(comObjectNode, "Number"),
      objectSize: attr(comObjectNode, "ObjectSize"),
      priority: attr(comObjectNode, "Priority"),
      readFlag: attr(comObjectNode, "ReadFlag"),
      readOnInitFlag: attr(comObjectNode, "ReadOnInitFlag"),
      text: attr(comObjectNode, "Text"),
      transmitFlag: attr(comObjectNode, "TransmitFlag"),
      updateFlag: attr(comObjectNode, "UpdateFlag"),
      writeFlag: attr(comObjectNode, "WriteFlag"),
    });
  });
}

function parseComObjectRefs(staticNode, context) {
  const comObjectRefsNode = childByName(staticNode, "ComObjectRefs");
  if (!comObjectRefsNode) {
    return;
  }

  walkElements(comObjectRefsNode, (comObjectRefNode) => {
    if (localName(comObjectRefNode) !== "ComObjectRef") {
      return;
    }

    context.comObjectRefs.set(attr(comObjectRefNode, "Id"), {
      communicationFlag: attr(comObjectRefNode, "CommunicationFlag"),
      functionText: attr(comObjectRefNode, "FunctionText"),
      id: attr(comObjectRefNode, "Id"),
      readFlag: attr(comObjectRefNode, "ReadFlag"),
      readOnInitFlag: attr(comObjectRefNode, "ReadOnInitFlag"),
      refId: attr(comObjectRefNode, "RefId"),
      text: attr(comObjectRefNode, "Text"),
      textParameterRefId: attr(comObjectRefNode, "TextParameterRefId"),
      transmitFlag: attr(comObjectRefNode, "TransmitFlag"),
      updateFlag: attr(comObjectRefNode, "UpdateFlag"),
      writeFlag: attr(comObjectRefNode, "WriteFlag"),
    });
  });
}

function parseDynamicChildren(parentNode, context) {
  return parseDynamicChildrenScoped(parentNode, context, null);
}

function parseDynamicChildrenScoped(parentNode, context, scope) {
  const children = [];

  for (const childNode of elementChildren(parentNode)) {
    const parsedNode = parseDynamicNode(childNode, context, scope);
    if (Array.isArray(parsedNode)) {
      children.push(...parsedNode);
      continue;
    }

    if (parsedNode) {
      children.push(parsedNode);
    }
  }

  return children;
}

function parseDynamicNode(node, context, scope) {
  switch (localName(node)) {
    case "Channel": {
      context.stats.channels += 1;
      return registerNode(
        {
          children: parseDynamicChildrenScoped(node, context, scope),
          helpContext: attr(node, "HelpContext"),
          icon: attr(node, "Icon"),
          id: scopedId(attr(node, "Id"), scope),
          kind: "channel",
          name: attr(node, "Name"),
          number: attr(node, "Number"),
          text: substituteModuleText(attr(node, "Text", attr(node, "Name")), scope),
          textParameterRefId: scopedId(attr(node, "TextParameterRefId"), scope),
        },
        context
      );
    }
    case "ChannelIndependentBlock": {
      return registerNode(
        {
          children: parseDynamicChildrenScoped(node, context, scope),
          helpContext: attr(node, "HelpContext"),
          id: scopedId(attr(node, "Id"), scope) || `ChannelIndependentBlock-${Math.random().toString(36).slice(2)}`,
          kind: "channelIndependentBlock",
          name: attr(node, "Name", "Global"),
          text: substituteModuleText(attr(node, "Text", attr(node, "Name", "Global")), scope),
        },
        context
      );
    }
    case "ParameterBlock": {
      context.stats.parameterBlocks += 1;
      const parameterRefId = scopedId(attr(node, "ParamRefId"), scope);
      const parameterRef = context.parameterRefs.get(parameterRefId);
      const parameter = parameterRef ? context.parameters.get(parameterRef.refId) : null;

      return registerNode(
        {
          children: parseDynamicChildrenScoped(node, context, scope),
          columns: parseGridAxis(childByName(node, "Columns"), "Column"),
          helpContext: attr(node, "HelpContext"),
          icon: attr(node, "Icon"),
          id: scopedId(attr(node, "Id"), scope),
          inline: attr(node, "Inline") === "true",
          kind: "parameterBlock",
          layout: attr(node, "Layout"),
          name: attr(node, "Name"),
          parameter,
          parameterRef,
          paramRefId: parameterRefId,
          rawText: substituteModuleText(attr(node, "Text"), scope),
          rows: parseGridAxis(childByName(node, "Rows"), "Row"),
          showInComObjectTree: attr(node, "ShowInComObjectTree"),
          text: substituteModuleText(attr(node, "Text", attr(node, "Name")), scope),
          textParameterRefId: scopedId(attr(node, "TextParameterRefId"), scope),
        },
        context
      );
    }
    case "ParameterSeparator": {
      return {
        cell: parseCell(attr(node, "Cell")),
        helpContext: attr(node, "HelpContext"),
        id: attr(node, "Id"),
        kind: "parameterSeparator",
        text: attr(node, "Text"),
        uiHint: attr(node, "UIHint"),
      };
    }
    case "ParameterRefRef": {
      const parameterRefId = scopedId(attr(node, "RefId"), scope);
      const parameterRef = context.parameterRefs.get(parameterRefId);
      const parameter = parameterRef ? context.parameters.get(parameterRef.refId) : null;
      const parameterType = parameter ? context.parameterTypes.get(parameter.parameterTypeId) : null;

      return {
        aliasName: attr(node, "AliasName"),
        cell: parseCell(attr(node, "Cell")),
        helpContext: attr(node, "HelpContext"),
        indentLevel: Number.parseInt(attr(node, "IndentLevel", "0"), 10) || 0,
        kind: "parameterRef",
        paramRefId: parameterRefId,
        parameter,
        parameterRef,
        parameterType,
      };
    }
    case "ComObjectRefRef": {
      const comObjectRefId = scopedId(attr(node, "RefId"), scope);
      const comObjectRef = context.comObjectRefs.get(comObjectRefId);
      const comObject = comObjectRef ? context.comObjects.get(comObjectRef.refId) : null;

      return {
        cell: parseCell(attr(node, "Cell")),
        comObject,
        comObjectRef,
        helpContext: attr(node, "HelpContext"),
        kind: "comObjectRef",
        refId: comObjectRefId,
      };
    }
    case "choose": {
      return {
        branches: childElements(node, "when").map((branchNode) => ({
          children: parseDynamicChildrenScoped(branchNode, context, scope),
          isDefault: attr(branchNode, "default") === "true",
          test: attr(branchNode, "test"),
        })),
        kind: "choose",
        paramRefId: scopedId(attr(node, "ParamRefId"), scope),
      };
    }
    case "Assign": {
      return {
        kind: "assign",
        targetParamRefRef: scopedId(attr(node, "TargetParamRefRef"), scope),
        value: attr(node, "Value"),
      };
    }
    case "Rename": {
      return {
        id: scopedId(attr(node, "Id"), scope),
        kind: "rename",
        targetId: scopedId(attr(node, "RefId"), scope),
        text: substituteModuleText(attr(node, "Text"), scope),
      };
    }
    case "Module": {
      return expandModule(node, context);
    }
    case "Button": {
      return {
        cell: parseCell(attr(node, "Cell")),
        eventHandler: attr(node, "EventHandler"),
        helpContext: attr(node, "HelpContext"),
        id: attr(node, "Id"),
        kind: "button",
        name: attr(node, "Name"),
        text: attr(node, "Text"),
      };
    }
    case "Rows":
    case "Columns":
      return null;
    default:
      context.unsupportedDynamicElements.add(localName(node));
      return null;
  }
}

function buildNavigationEntries(nodes) {
  return nodes
    .map((node) => buildNavigationEntry(node))
    .filter(Boolean);
}

function buildNavigationEntry(node) {
  if (node.kind === "channel" || node.kind === "channelIndependentBlock") {
    return {
      children: node.children.map((child) => buildNavigationEntry(child)).filter(Boolean),
      id: node.id,
      labelNodeId: node.id,
      kind: node.kind,
    };
  }

  if (node.kind === "parameterBlock" && !node.inline) {
    return {
      children: node.children.map((child) => buildNavigationEntry(child)).filter(Boolean),
      id: node.id,
      labelNodeId: node.id,
      kind: node.kind,
    };
  }

  return null;
}

function parseGridAxis(axisNode, itemName) {
  if (!axisNode) {
    return [];
  }

  return childElements(axisNode, itemName).map((itemNode) => ({
    id: attr(itemNode, "Id"),
    name: attr(itemNode, "Name"),
    text: attr(itemNode, "Text"),
    width: attr(itemNode, "Width"),
  }));
}

function parseCell(cellText) {
  if (!cellText) {
    return null;
  }

  const parts = cellText.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) {
    return null;
  }

  return {
    column: parts[1],
    row: parts[0],
  };
}

function applyAssignments(nodes, runtimeState) {
  let changed = false;

  for (const node of nodes) {
    if (node.kind === "choose") {
      for (const branch of resolveActiveChooseBranches(node, runtimeState)) {
        changed = applyAssignments(branch.children, runtimeState) || changed;
      }
      continue;
    }

    if (node.kind === "assign") {
      const assignedValue = String(node.value ?? "");
      if (runtimeState[node.targetParamRefRef] !== assignedValue) {
        runtimeState[node.targetParamRefRef] = assignedValue;
        changed = true;
      }
      continue;
    }

    if (node.kind === "rename") {
      const renameKey = `__rename__${node.targetId}`;
      const renamedText = String(node.text || "");
      if (runtimeState[renameKey] !== renamedText) {
        runtimeState[renameKey] = renamedText;
        changed = true;
      }
      continue;
    }

    if (node.children && node.children.length > 0) {
      changed = applyAssignments(node.children, runtimeState) || changed;
    }
  }

  return changed;
}

function resolveActiveChooseBranches(node, runtimeState) {
  const currentValue = runtimeState[node.paramRefId] ?? "";
  const matchingBranches = node.branches.filter((branch) => matchesWhenTest(branch.test, currentValue));
  if (matchingBranches.length > 0) {
    return matchingBranches;
  }

  return node.branches.filter((branch) => branch.isDefault);
}

function matchesWhenTest(testExpression, currentValue) {
  const test = (testExpression || "").trim();
  const value = String(currentValue ?? "").trim();

  if (!test) {
    return false;
  }

  if (test.startsWith("!=")) {
    return !valuesEqual(test.slice(2).trim(), value);
  }
  if (test.startsWith(">=")) {
    return compareNumerically(value, test.slice(2).trim(), (left, right) => left >= right);
  }
  if (test.startsWith("<=")) {
    return compareNumerically(value, test.slice(2).trim(), (left, right) => left <= right);
  }
  if (test.startsWith(">")) {
    return compareNumerically(value, test.slice(1).trim(), (left, right) => left > right);
  }
  if (test.startsWith("<")) {
    return compareNumerically(value, test.slice(1).trim(), (left, right) => left < right);
  }
  if (test.startsWith("=")) {
    return valuesEqual(test.slice(1).trim(), value);
  }
  if (/\s/.test(test)) {
    return test.split(/\s+/).some((candidate) => valuesEqual(candidate, value));
  }
  return valuesEqual(test, value);
}

function valuesEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (isNumericString(left) && isNumericString(right)) {
    return Number(left) === Number(right);
  }
  return false;
}

function compareNumerically(left, right, comparator) {
  if (!isNumericString(left) || !isNumericString(right)) {
    return false;
  }
  return comparator(Number(left), Number(right));
}

function isNumericString(value) {
  return value !== "" && !Number.isNaN(Number(value));
}

function resolveTemplateText(text, textParameterRefId, runtimeState) {
  const sourceText = text || "";
  if (!sourceText.includes("{{")) {
    return sourceText;
  }

  const textValue = textParameterRefId ? String(runtimeState[textParameterRefId] ?? "") : "";
  const withFallbackResolved = sourceText.replace(/\{\{\d+:([^}]*)\}\}/g, (_match, fallback) => textValue || fallback || "");
  return withFallbackResolved.replace(/\{\{\d+\}\}/g, () => textValue);
}

function registerNode(node, context) {
  if (node.id) {
    context.nodeIndex.set(node.id, node);
  }
  return node;
}

function parseModuleDefinitions(appNode, context) {
  const moduleDefsNode = childByName(appNode, "ModuleDefs");
  if (!moduleDefsNode) {
    return;
  }

  for (const moduleDefNode of childElements(moduleDefsNode, "ModuleDef")) {
    const moduleDefId = attr(moduleDefNode, "Id");
    if (!moduleDefId) {
      continue;
    }

    const argumentsById = new Map();
    const argumentsNode = childByName(moduleDefNode, "Arguments");
    for (const argumentNode of childElements(argumentsNode, "Argument")) {
      const argumentId = attr(argumentNode, "Id");
      if (!argumentId) {
        continue;
      }

      argumentsById.set(argumentId, {
        id: argumentId,
        name: attr(argumentNode, "Name"),
      });
    }

    const templateIds = captureModuleTemplateIds(moduleDefId, context);
    const moduleStaticNode = childByName(moduleDefNode, "Static");
    if (moduleStaticNode) {
      const currentParameterCount = context.stats.parameters;
      parseParameterTypes(moduleStaticNode, context);
      parseParameters(moduleStaticNode, context);
      parseParameterRefs(moduleStaticNode, context);
      parseComObjects(moduleStaticNode, context);
      parseComObjectRefs(moduleStaticNode, context);
      context.stats.parameters = currentParameterCount;
    }

    const capturedTemplateIds = captureModuleTemplateIds(moduleDefId, context);
    context.moduleDefinitions.set(moduleDefId, {
      argumentsById,
      dynamicNode: childByName(moduleDefNode, "Dynamic"),
      id: moduleDefId,
      templateIds: {
        comObjectRefs: [...capturedTemplateIds.comObjectRefs.keys()],
        comObjects: [...capturedTemplateIds.comObjects.keys()],
        parameterRefs: [...capturedTemplateIds.parameterRefs.keys()],
        parameters: [...capturedTemplateIds.parameters.keys()],
        parameterTypes: [...capturedTemplateIds.parameterTypes.keys()],
      },
    });

    // Keep only the ids that belong to this module template.
    context.moduleDefinitions.get(moduleDefId).templateIds = {
      comObjectRefs: context.moduleDefinitions.get(moduleDefId).templateIds.comObjectRefs.filter((id) => !templateIds.comObjectRefs.has(id)),
      comObjects: context.moduleDefinitions.get(moduleDefId).templateIds.comObjects.filter((id) => !templateIds.comObjects.has(id)),
      parameterRefs: context.moduleDefinitions.get(moduleDefId).templateIds.parameterRefs.filter((id) => !templateIds.parameterRefs.has(id)),
      parameters: context.moduleDefinitions.get(moduleDefId).templateIds.parameters.filter((id) => !templateIds.parameters.has(id)),
      parameterTypes: context.moduleDefinitions.get(moduleDefId).templateIds.parameterTypes.filter((id) => !templateIds.parameterTypes.has(id)),
    };
  }
}

function captureModuleTemplateIds(moduleDefId, context) {
  return {
    comObjectRefs: new Set([...context.comObjectRefs.keys()].filter((id) => isModuleTemplateId(id, moduleDefId))),
    comObjects: new Set([...context.comObjects.keys()].filter((id) => isModuleTemplateId(id, moduleDefId))),
    parameterRefs: new Set([...context.parameterRefs.keys()].filter((id) => isModuleTemplateId(id, moduleDefId))),
    parameters: new Set([...context.parameters.keys()].filter((id) => isModuleTemplateId(id, moduleDefId))),
    parameterTypes: new Set([...context.parameterTypes.keys()].filter((id) => isModuleTemplateId(id, moduleDefId))),
  };
}

function isModuleTemplateId(id, moduleDefId) {
  const value = String(id || "");
  const moduleToken = `${moduleDefId}_`;
  return value.includes(moduleToken);
}

function expandModule(moduleNode, context) {
  const moduleDefId = attr(moduleNode, "RefId");
  const moduleDef = context.moduleDefinitions.get(moduleDefId);
  if (!moduleDef || !moduleDef.dynamicNode) {
    context.unsupportedDynamicElements.add("Module");
    return [];
  }

  const moduleId = attr(moduleNode, "Id");
  if (!moduleId) {
    context.unsupportedDynamicElements.add("Module");
    return [];
  }

  const moduleArguments = resolveModuleArguments(moduleNode, moduleDef);
  ensureModuleInstanceDefinitions(moduleDef, moduleId, moduleArguments, context);

  const scope = {
    moduleArguments,
    moduleDefId,
    moduleId,
  };
  return parseDynamicChildrenScoped(moduleDef.dynamicNode, context, scope);
}

function resolveModuleArguments(moduleNode, moduleDef) {
  const valuesByRefId = new Map();
  for (const argumentNode of elementChildren(moduleNode)) {
    const argumentTag = localName(argumentNode);
    if (argumentTag !== "NumericArg" && argumentTag !== "TextArg") {
      continue;
    }

    const argumentRefId = attr(argumentNode, "RefId");
    if (!argumentRefId) {
      continue;
    }

    valuesByRefId.set(argumentRefId, attr(argumentNode, "Value"));
  }

  const valuesByName = Object.create(null);
  for (const [argumentRefId, value] of valuesByRefId.entries()) {
    const argument = moduleDef.argumentsById.get(argumentRefId);
    if (argument?.name) {
      valuesByName[argument.name] = value;
    }
  }

  return {
    byName: valuesByName,
    byRefId: valuesByRefId,
  };
}

function ensureModuleInstanceDefinitions(moduleDef, moduleId, moduleArguments, context) {
  if (context.moduleInstances.has(moduleId)) {
    return;
  }

  for (const parameterTypeId of moduleDef.templateIds.parameterTypes) {
    const templateType = context.parameterTypes.get(parameterTypeId);
    if (!templateType) {
      continue;
    }

    const instanceTypeId = scopedId(parameterTypeId, { moduleDefId: moduleDef.id, moduleId });
    if (!context.parameterTypes.has(instanceTypeId)) {
      context.parameterTypes.set(instanceTypeId, {
        ...templateType,
        id: instanceTypeId,
      });
    }
  }

  for (const parameterId of moduleDef.templateIds.parameters) {
    const templateParameter = context.parameters.get(parameterId);
    if (!templateParameter) {
      continue;
    }

    const instanceParameterId = scopedId(parameterId, { moduleDefId: moduleDef.id, moduleId });
    if (!context.parameters.has(instanceParameterId)) {
      context.parameters.set(instanceParameterId, {
        ...templateParameter,
        id: instanceParameterId,
        parameterTypeId: scopedId(templateParameter.parameterTypeId, { moduleDefId: moduleDef.id, moduleId }),
      });
    }
  }

  for (const parameterRefId of moduleDef.templateIds.parameterRefs) {
    const templateParameterRef = context.parameterRefs.get(parameterRefId);
    if (!templateParameterRef) {
      continue;
    }

    const instanceParameterRefId = scopedId(parameterRefId, { moduleDefId: moduleDef.id, moduleId });
    if (!context.parameterRefs.has(instanceParameterRefId)) {
      context.parameterRefs.set(instanceParameterRefId, {
        ...templateParameterRef,
        id: instanceParameterRefId,
        refId: scopedId(templateParameterRef.refId, { moduleDefId: moduleDef.id, moduleId }),
      });
    }
  }

  const objectNumberBase = Number(moduleArguments.byName.ObjNumberBase);
  for (const comObjectId of moduleDef.templateIds.comObjects) {
    const templateComObject = context.comObjects.get(comObjectId);
    if (!templateComObject) {
      continue;
    }

    const instanceComObjectId = scopedId(comObjectId, { moduleDefId: moduleDef.id, moduleId });
    if (!context.comObjects.has(instanceComObjectId)) {
      let number = templateComObject.number;
      if (Number.isFinite(objectNumberBase) && isNumericString(number)) {
        number = String(Number(number) + objectNumberBase);
      }

      context.comObjects.set(instanceComObjectId, {
        ...templateComObject,
        id: instanceComObjectId,
        number,
      });
    }
  }

  for (const comObjectRefId of moduleDef.templateIds.comObjectRefs) {
    const templateComObjectRef = context.comObjectRefs.get(comObjectRefId);
    if (!templateComObjectRef) {
      continue;
    }

    const instanceComObjectRefId = scopedId(comObjectRefId, { moduleDefId: moduleDef.id, moduleId });
    if (!context.comObjectRefs.has(instanceComObjectRefId)) {
      context.comObjectRefs.set(instanceComObjectRefId, {
        ...templateComObjectRef,
        id: instanceComObjectRefId,
        refId: scopedId(templateComObjectRef.refId, { moduleDefId: moduleDef.id, moduleId }),
        textParameterRefId: scopedId(templateComObjectRef.textParameterRefId, { moduleDefId: moduleDef.id, moduleId }),
      });
    }
  }

  context.moduleInstances.add(moduleId);
}

function scopedId(rawId, scope) {
  const value = String(rawId || "");
  if (!scope || !value || !scope.moduleDefId || !scope.moduleId) {
    return value;
  }

  return value.replace(scope.moduleDefId, scope.moduleId);
}

function substituteModuleText(text, scope) {
  const value = String(text || "");
  if (!scope || !value.includes("{{") || !scope.moduleArguments?.byName) {
    return value;
  }

  return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (match, token) => {
    if (Object.prototype.hasOwnProperty.call(scope.moduleArguments.byName, token)) {
      return String(scope.moduleArguments.byName[token] ?? "");
    }

    return match;
  });
}

function hasDescendant(parentNode, name) {
  return parentNode.getElementsByTagNameNS("*", name).length > 0;
}

function firstByPath(rootNode, path) {
  let currentNode = rootNode;
  for (const segment of path) {
    currentNode = childByName(currentNode, segment);
    if (!currentNode) {
      return null;
    }
  }
  return currentNode;
}

function childByName(parentNode, name) {
  return elementChildren(parentNode).find((childNode) => localName(childNode) === name) || null;
}

function childElements(parentNode, name) {
  return elementChildren(parentNode).filter((childNode) => localName(childNode) === name);
}

function firstElementChild(parentNode) {
  return elementChildren(parentNode)[0] || null;
}

function elementChildren(parentNode) {
  if (!parentNode) {
    return [];
  }
  return Array.from(parentNode.childNodes).filter((childNode) => childNode.nodeType === ELEMENT_NODE);
}

function walkElements(node, visitor) {
  for (const childNode of elementChildren(node)) {
    visitor(childNode);
    walkElements(childNode, visitor);
  }
}

function localName(node) {
  return node.localName || node.nodeName;
}

function buildTranslationMap(appNode, languageIdentifier) {
  const normalizedLanguage = String(languageIdentifier || "").trim().toLowerCase();
  if (!appNode || !normalizedLanguage) {
    return new Map();
  }

  const manufacturerNode = firstByPath(appNode.ownerDocument?.documentElement, ["ManufacturerData", "Manufacturer"]);
  const languagesNode = childByName(manufacturerNode, "Languages");
  if (!languagesNode) {
    return new Map();
  }

  const languageNode = childElements(languagesNode, "Language").find(
    (candidateNode) => attr(candidateNode, "Identifier").trim().toLowerCase() === normalizedLanguage
  );
  if (!languageNode) {
    return new Map();
  }

  const translations = new Map();
  for (const translationUnitNode of childElements(languageNode, "TranslationUnit")) {
    for (const translationElementNode of childElements(translationUnitNode, "TranslationElement")) {
      const refId = attr(translationElementNode, "RefId");
      if (!refId) {
        continue;
      }

      const translatedAttributes = Object.create(null);
      for (const translationNode of childElements(translationElementNode, "Translation")) {
        const attributeName = attr(translationNode, "AttributeName");
        if (!attributeName) {
          continue;
        }

        translatedAttributes[attributeName] = attr(translationNode, "Text");
      }

      if (Object.keys(translatedAttributes).length > 0) {
        translations.set(refId, translatedAttributes);
      }
    }
  }

  return translations;
}

function resolveTranslatedAttribute(node, name) {
  if (!node || !TRANSLATABLE_ATTRIBUTES.has(name) || typeof node.getAttribute !== "function") {
    return null;
  }

  const ownerDocument = node.ownerDocument || node;
  const translationMap = translationMapsByDocument.get(ownerDocument);
  if (!translationMap) {
    return null;
  }

  const refId = node.getAttribute("Id") || node.getAttribute("RefId");
  if (!refId || !translationMap.has(refId)) {
    return null;
  }

  const translatedAttributes = translationMap.get(refId);
  if (!translatedAttributes || !Object.prototype.hasOwnProperty.call(translatedAttributes, name)) {
    return null;
  }

  return translatedAttributes[name];
}

function attr(node, name, fallback = "") {
  if (!node) {
    return fallback;
  }

  const translatedValue = resolveTranslatedAttribute(node, name);
  if (translatedValue !== null && translatedValue !== undefined && translatedValue !== "") {
    return translatedValue;
  }

  return node.getAttribute(name) ?? fallback;
}