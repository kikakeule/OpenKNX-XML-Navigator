const ELEMENT_NODE = 1;

export function buildSimulatorModel(xmlText) {
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

  const staticNode = childByName(appNode, "Static");
  const dynamicNode = childByName(appNode, "Dynamic");
  if (!staticNode || !dynamicNode) {
    throw new Error("Static oder Dynamic fehlt in der XML.");
  }

  const context = {
    comObjectRefs: new Map(),
    comObjects: new Map(),
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

  const initialState = Object.create(null);
  for (const parameterRef of context.parameterRefs.values()) {
    const parameter = context.parameters.get(parameterRef.refId);
    if (parameter) {
      initialState[parameterRef.id] = parameter.value;
    }
  }

  const roots = parseDynamicChildren(dynamicNode, context);
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
      defaultLanguage: attr(appNode, "DefaultLanguage", "de"),
      name: attr(appNode, "Name", "ApplicationProgram"),
      programType: attr(appNode, "ProgramType"),
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
      const currentValue = runtimeState[node.paramRefId] ?? "";
      for (const branch of node.branches) {
        if (matchesWhenTest(branch.test, currentValue)) {
          materialized.push(...materializeNodes(branch.children, runtimeState));
        }
      }
      continue;
    }

    if (node.kind === "assign") {
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

  return resolveTemplateText(node.text || node.name || node.number || node.id, node.textParameterRefId, runtimeState);
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
  const children = [];

  for (const childNode of elementChildren(parentNode)) {
    const parsedNode = parseDynamicNode(childNode, context);
    if (parsedNode) {
      children.push(parsedNode);
    }
  }

  return children;
}

function parseDynamicNode(node, context) {
  switch (localName(node)) {
    case "Channel": {
      context.stats.channels += 1;
      return registerNode(
        {
          children: parseDynamicChildren(node, context),
          helpContext: attr(node, "HelpContext"),
          icon: attr(node, "Icon"),
          id: attr(node, "Id"),
          kind: "channel",
          name: attr(node, "Name"),
          number: attr(node, "Number"),
          text: attr(node, "Text", attr(node, "Name")),
          textParameterRefId: attr(node, "TextParameterRefId"),
        },
        context
      );
    }
    case "ChannelIndependentBlock": {
      return registerNode(
        {
          children: parseDynamicChildren(node, context),
          helpContext: attr(node, "HelpContext"),
          id: attr(node, "Id") || `ChannelIndependentBlock-${Math.random().toString(36).slice(2)}`,
          kind: "channelIndependentBlock",
          name: attr(node, "Name", "Global"),
          text: attr(node, "Text", attr(node, "Name", "Global")),
        },
        context
      );
    }
    case "ParameterBlock": {
      context.stats.parameterBlocks += 1;
      return registerNode(
        {
          children: parseDynamicChildren(node, context),
          columns: parseGridAxis(childByName(node, "Columns"), "Column"),
          helpContext: attr(node, "HelpContext"),
          icon: attr(node, "Icon"),
          id: attr(node, "Id"),
          inline: attr(node, "Inline") === "true",
          kind: "parameterBlock",
          layout: attr(node, "Layout"),
          name: attr(node, "Name"),
          rawText: attr(node, "Text"),
          rows: parseGridAxis(childByName(node, "Rows"), "Row"),
          showInComObjectTree: attr(node, "ShowInComObjectTree"),
          text: attr(node, "Text", attr(node, "Name")),
          textParameterRefId: attr(node, "TextParameterRefId"),
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
      const parameterRefId = attr(node, "RefId");
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
      const comObjectRefId = attr(node, "RefId");
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
          children: parseDynamicChildren(branchNode, context),
          test: attr(branchNode, "test"),
        })),
        kind: "choose",
        paramRefId: attr(node, "ParamRefId"),
      };
    }
    case "Assign": {
      return {
        kind: "assign",
        targetParamRefRef: attr(node, "TargetParamRefRef"),
        value: attr(node, "Value"),
      };
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
      const currentValue = runtimeState[node.paramRefId] ?? "";
      for (const branch of node.branches) {
        if (matchesWhenTest(branch.test, currentValue)) {
          changed = applyAssignments(branch.children, runtimeState) || changed;
        }
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

    if (node.children && node.children.length > 0) {
      changed = applyAssignments(node.children, runtimeState) || changed;
    }
  }

  return changed;
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
  return sourceText.replace(/\{\{\d+:([^}]*)\}\}/g, (_match, fallback) => textValue || fallback || "");
}

function registerNode(node, context) {
  if (node.id) {
    context.nodeIndex.set(node.id, node);
  }
  return node;
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

function attr(node, name, fallback = "") {
  if (!node) {
    return fallback;
  }
  return node.getAttribute(name) ?? fallback;
}