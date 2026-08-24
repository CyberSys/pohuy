import {
  copyToClipboard,
  getMarkdownTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { fitSettingsRender, SETTINGS_PATH } from "./settings-store.js";
import {
  buildStylePrompt,
  buildStylePromptReport,
  entryEnabled,
  flattenNodes,
  inheritedEntryEnabled,
  selectedSectionIds,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_LABELS,
  type ConfigNode,
  type SettingsPatch,
  type SettingsSection,
  type StoredSettings,
  type StoredTier,
  type StyleSource,
} from "./style-source.js";

type TriState = "enabled" | "disabled" | "partial";
const STATE_LABELS: Record<TriState, string> = {
  enabled: "включено",
  disabled: "выключено",
  partial: "частично",
};
function stateLabel(state: TriState): string {
  return STATE_LABELS[state];
}
type TreeRow = { node: ConfigNode; depth: number };
type SettingsTheme = ExtensionContext["ui"]["theme"];
const METADATA_LABEL_WIDTH = 12;

function formatCharacterCount(value: number): string {
  return value.toLocaleString("ru-RU");
}

function generalRoots(settings: StoredSettings, source: StyleSource): ConfigNode[] {
  const customSources = settings.selectedSections !== undefined || Object.keys(settings.itemOverrides ?? {}).length > 0;
  const report = buildStylePromptReport(settings, source);
  return [
    {
      id: "setting:tier",
      kind: "setting",
      section: "general",
      label: `Режим: ${settings.tier}`,
      description: "normal отключает стиль. lite, full и ultra постепенно усиливают его. Остальные настройки сохраняются.",
      markdown: "",
      path: "settings.json",
      line: 1,
      aliases: ["mode", "tier"],
      children: [],
    },
    {
      id: "setting:preview",
      kind: "setting",
      section: "general",
      label: report.managedBlock
        ? `Итоговая инструкция: ${formatCharacterCount(report.managedCharacters)} симв.`
        : "Итоговая инструкция: не добавляется",
      description: "Точный блок POHUY для системного промпта. Размер остального промпта Pi не входит в счётчик.",
      markdown: "",
      path: "generated://pohuy",
      line: 1,
      aliases: ["prompt", "preview", "итог"],
      children: [],
    },
    {
      id: "setting:preset",
      kind: "setting",
      section: "general",
      label: `Набор источников: ${customSources ? "custom" : "tier-defaults"}`,
      description: "tier-defaults использует набор текущего режима. custom хранит ручной выбор.",
      markdown: "",
      path: "settings.json",
      line: 1,
      aliases: ["source preset"],
      children: [],
    },
  ];
}

function stateFrom(states: TriState[]): TriState {
  if (states.length === 0 || states.every((state) => state === "disabled")) return "disabled";
  if (states.every((state) => state === "enabled")) return "enabled";
  return "partial";
}

function nodeState(node: ConfigNode, settings: StoredSettings, source: StyleSource): TriState {
  if (node.id === "setting:preview") return buildStylePrompt(settings, source) ? "enabled" : "disabled";
  if (node.kind === "setting") return "enabled";
  if (node.id === "component:style-skill") return settings.skillEnabled === false ? "disabled" : "enabled";
  if (node.id === "component:dictionary-resource") {
    return stateFrom(flattenNodes(source.roots.dictionary).filter((item) => item.kind === "entry").map((item) => nodeState(item, settings, source)));
  }
  if (node.id === "component:scenes-resource") {
    return stateFrom(flattenNodes(source.roots.scenes).filter((item) => item.kind === "scene").map((item) => nodeState(item, settings, source)));
  }
  if (node.children.length > 0) return stateFrom(node.children.map((child) => nodeState(child, settings, source)));
  if (node.kind === "entry") return entryEnabled(node, settings, source) ? "enabled" : "disabled";
  if (node.optionId) return selectedSectionIds(settings, source).includes(node.optionId) ? "enabled" : "disabled";
  return "disabled";
}

function sectionRoots(section: SettingsSection, settings: StoredSettings, source: StyleSource): ConfigNode[] {
  return section === "general" ? generalRoots(settings, source) : source.roots[section];
}

function parentOf(target: ConfigNode, source: StyleSource, settings: StoredSettings): ConfigNode | undefined {
  const roots = sectionRoots(target.section, settings, source);
  return flattenNodes(roots).find((node) => node.children.some((child) => child.id === target.id));
}

function ancestorChain(target: ConfigNode, source: StyleSource, settings: StoredSettings): ConfigNode[] {
  const result: ConfigNode[] = [];
  let current = parentOf(target, source, settings);
  while (current) {
    result.unshift(current);
    current = parentOf(current, source, settings);
  }
  return result;
}

function visibleTreeRows(roots: ConfigNode[], expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (node: ConfigNode, depth: number) => {
    rows.push({ node, depth });
    if (node.children.length > 0 && expanded.has(node.id)) {
      for (const child of node.children) visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

function countState(nodes: ConfigNode[], settings: StoredSettings, source: StyleSource): { enabled: number; total: number } {
  const leaves = flattenNodes(nodes).filter((node) => node.children.length === 0 && node.kind !== "setting");
  return { enabled: leaves.filter((node) => nodeState(node, settings, source) === "enabled").length, total: leaves.length };
}

function checkbox(state: TriState, theme: SettingsTheme): string {
  if (state === "enabled") return theme.fg("success", "[✓]");
  if (state === "partial") return theme.fg("warning", "[-]");
  return theme.fg("muted", "[ ]");
}

function fitCell(value: string, width: number, align: "left" | "right" = "left"): string {
  const fitted = truncateToWidth(value, Math.max(0, width), "");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
  return align === "right" ? padding + fitted : fitted + padding;
}

function alignHeader(left: string, right: string, width: number): string {
  if (visibleWidth(left) + visibleWidth(right) + 1 <= width) {
    return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
  }
  if (right && visibleWidth(right) + 2 < width) {
    const fittedLeft = truncateToWidth(left, width - visibleWidth(right) - 1, "…");
    return fittedLeft + " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(right))) + right;
  }
  return truncateToWidth(left, width, "…");
}

function tabsLine(active: SettingsSection, theme: SettingsTheme): string {
  return SETTINGS_SECTIONS.map((section) => {
    const label = SETTINGS_SECTION_LABELS[section];
    return section === active
      ? theme.fg("accent", theme.bold(`[${label}]`))
      : theme.fg("text", label);
  }).join(" ");
}

function searchControl(input: Input, active: boolean, maxWidth: number, theme: SettingsTheme, focused = active): string {
  const bracketColor = "accent";
  if (!active) {
    return theme.fg(bracketColor, "[") + ` ${theme.fg("accent", "/")} ${theme.fg("muted", "поиск")} ` + theme.fg(bracketColor, "]");
  }
  input.focused = focused;
  const contentWidth = Math.max(1, maxWidth - 4);
  const value = focused
    ? (input.render(contentWidth + 2)[0] ?? "").slice(2)
    : truncateToWidth(input.getValue(), contentWidth, "");
  return theme.fg(bracketColor, "[") + ` ${value} ` + theme.fg(bracketColor, "]");
}

function sourceLocation(node: ConfigNode): string {
  return node.kind === "setting" || node.kind === "component" ? node.path : `${node.path}:${node.line}`;
}

function splitSourceDocument(markdown: string): { frontmatter?: string; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)*/u);
  if (!match) return { body: markdown };
  return {
    frontmatter: match[1],
    body: markdown.slice(match[0].length),
  };
}

function sceneBodyMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  if (/^###\s+/.test(lines[0] ?? "")) lines.shift();
  while (lines[0]?.trim() === "") lines.shift();
  if (/^Лексика:\s*/.test(lines[0] ?? "")) lines.shift();
  while (lines[0]?.trim() === "") lines.shift();
  return lines.join("\n").trim();
}

function dictionaryMatchCountLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  const noun = last === 1 && lastTwo !== 11
    ? "запись"
    : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)
      ? "записи"
      : "записей";
  return `${count} ${noun}`;
}

function openSectionFor(node: ConfigNode): SettingsSection | undefined {
  if (node.id === "component:dictionary-resource") return "dictionary";
  if (node.id === "component:scenes-resource") return "scenes";
  return undefined;
}

function canToggleNode(node: ConfigNode): boolean {
  if (node.kind === "setting") return node.id === "setting:tier" || node.id === "setting:preset";
  if (["component:style-skill", "component:dictionary-resource", "component:scenes-resource"].includes(node.id)) return true;
  return node.optionId !== undefined || node.children.some(canToggleNode);
}

function toggleFooterDescription(node: ConfigNode): string {
  if (node.kind === "setting") return "изменить настройку";
  if (node.kind === "group") return "переключить группу";
  if (node.kind === "entry") return "переключить запись";
  if (node.kind === "scene") return "переключить сцену";
  return "переключить ресурс";
}

function treeFooterActions(node: ConfigNode | undefined, expanded: Set<string>, hasParent: boolean): Array<[string, string]> {
  if (!node) return [];
  if (node.children.length > 0 && expanded.has(node.id)) {
    return [["←/h", "свернуть"], ["→/l", "к первому пункту"]];
  }
  return [
    ...(hasParent ? [["←/h", "к родителю"] as [string, string]] : []),
    ...(node.children.length > 0 ? [["→/l", "раскрыть"] as [string, string]] : []),
  ];
}


function metadataLine(label: string, value: string, width: number, theme: SettingsTheme): string {
  return truncateToWidth(`${theme.fg("muted", fitCell(label, METADATA_LABEL_WIDTH))} ${theme.fg("text", value)}`, width, "");
}

function metadataLines(label: string, value: string, width: number, theme: SettingsTheme): string[] {
  const valueWidth = Math.max(1, width - METADATA_LABEL_WIDTH - 1);
  const wrapped = wrapTextWithAnsi(value, valueWidth);
  return wrapped.map((line, index) =>
    `${index === 0 ? theme.fg("muted", fitCell(label, METADATA_LABEL_WIDTH)) : " ".repeat(METADATA_LABEL_WIDTH)} ${theme.fg("text", line)}`
  );
}

function relatedDictionaryGroups(node: ConfigNode, source: StyleSource): Array<{ label: string; matches: number }> {
  const haystack = `${node.label}\n${node.markdown}`.toLocaleLowerCase("ru-RU");
  return source.roots.dictionary.flatMap((group) => {
    const matches = flattenNodes([group]).filter((candidate) => {
      if (candidate.kind !== "entry") return false;
      const terms = [candidate.label, ...candidate.aliases]
        .flatMap((term) => term.split(/\s*\/\s*/))
        .map((term) => term.toLocaleLowerCase("ru-RU").trim())
        .filter((term) => visibleWidth(term) >= 4);
      return terms.some((term) => haystack.includes(term));
    }).length;
    return matches > 0 ? [{ label: group.label, matches }] : [];
  });
}

function reflowMarkdownPreview(markdown: string): string {
  const output: string[] = [];
  let paragraph: string[] = [];
  let paragraphKind: "text" | "quote" | undefined;
  let fenced = false;
  const flush = () => {
    if (paragraph.length > 0) output.push(paragraph.join(" "));
    paragraph = [];
    paragraphKind = undefined;
  };

  for (const line of markdown.split("\n")) {
    if (/^\s*```/u.test(line)) {
      flush();
      output.push(line);
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      output.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      output.push("");
      continue;
    }
    if (/^(?:\s{0,3}#{1,6}\s|\s*\| |\s*[-*_]{3,}\s*$|\s{4}\S|\s*<[^>]+>)/u.test(line)) {
      flush();
      output.push(line);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/u);
    if (quote) {
      if (paragraphKind !== "quote") flush();
      paragraphKind = "quote";
      paragraph.push(paragraph.length === 0 ? `> ${quote[1].trim()}` : quote[1].trim());
      continue;
    }
    if (paragraphKind === "quote") flush();
    if (/^\s*(?:[-*+] |\d+[.)] )/u.test(line)) flush();
    paragraphKind = "text";
    paragraph.push(line.trim());
    if (/\s{2}$/u.test(line)) flush();
  }
  flush();
  return output.join("\n");
}

function promptReportLines(width: number, settings: StoredSettings, source: StyleSource, theme: SettingsTheme): string[] {
  const report = buildStylePromptReport(settings, source);
  const active = report.managedBlock !== undefined;
  const customSections = settings.selectedSections !== undefined;
  const lines = [theme.fg("text", theme.bold("Итоговая инструкция Pohuy"))];
  const meta = (label: string, value: string) => lines.push(...metadataLines(label, value, width, theme));
  meta("СОСТОЯНИЕ", theme.fg(active ? "success" : "muted", active ? "добавляется в системный промпт" : "не добавляется"));
  meta("РЕЖИМ", settings.tier);
  meta("РАЗМЕР", `${formatCharacterCount(report.managedCharacters)} символов в блоке POHUY`);
  meta("ПОЛИТИКА", `${formatCharacterCount(report.policyCharacters)} символов без маркеров POHUY`);
  meta("РАЗДЕЛЫ", `${report.selectedSections} из ${report.totalSections}`);
  meta("НАБОР", customSections ? "ручной" : `стандартный для режима ${settings.tier}`);
  meta("SLOVAR.MD", `${report.dictionaryEnabled}/${report.dictionaryTotal} записей включено`);
  meta("СЦЕНЫ", `${report.scenesEnabled}/${report.scenesTotal} сцен включено`);
  meta("ХУЕНИТИВЫ", report.huenitivEnabled ? "включены" : "выключены");
  if (report.explicitOverrides === 0) {
    meta("ПРАВКИ", "нет");
  } else {
    meta("ДОБАВЛЕНО", dictionaryMatchCountLabel(report.explicitlyEnabled));
    meta("УБРАНО", dictionaryMatchCountLabel(report.explicitlyDisabled));
  }

  if (report.stylePrompt) {
    lines.push("", theme.fg("muted", "ТЕКСТ БЛОКА"));
    lines.push(...new Markdown(reflowMarkdownPreview(report.stylePrompt), 0, 0, getMarkdownTheme()).render(Math.max(1, width)));
  } else {
    lines.push("", theme.fg("muted", settings.skillEnabled === false
      ? "Стилевой skill выключен. Выбор словаря и сцен сохранён."
      : "Режим normal: блок POHUY отсутствует. Остальные настройки сохранены."));
  }
  return lines.flatMap((line) => line === "" ? [""] : wrapTextWithAnsi(line, Math.max(1, width)));
}

function detailLines(node: ConfigNode, width: number, settings: StoredSettings, source: StyleSource, theme: SettingsTheme, showNeighbors = false): string[] {
  if (node.id === "setting:preview") return promptReportLines(width, settings, source, theme);
  const state = nodeState(node, settings, source);
  const stateColor = state === "enabled" ? "success" : state === "partial" ? "warning" : "muted";
  const status = node.kind === "entry" && settings.itemOverrides?.[node.id] !== undefined
    ? `${stateLabel(state)} (переопределено)`
    : stateLabel(state);
  const title = node.id === "setting:tier"
    ? theme.fg("text", theme.bold(`Режим: ${settings.tier}`)) + theme.fg("muted", ` (${(["normal", "lite", "full", "ultra"] as StoredTier[]).filter((tier) => tier !== settings.tier).join(", ")})`)
    : theme.fg("text", theme.bold(node.label));
  const lines = [title];
  const meta = (label: string, value: string) => lines.push(...metadataLines(label, value, width, theme));
  meta("СОСТОЯНИЕ", theme.fg(stateColor, status));
  meta("ИСТОЧНИК", sourceLocation(node));
  if (node.kind === "entry" && settings.itemOverrides?.[node.id] === false) {
    meta("ПРИМЕНЕНИЕ", "термин исключён из системного промпта");
  }
  if (node.kind !== "entry" && node.kind !== "scene" && node.description) meta("ЧТО ДЕЛАЕТ", node.description);
  if (node.kind === "setting") meta("ЗАГРУЖЕНО ИЗ", SETTINGS_PATH);
  const ancestors = ancestorChain(node, source, settings);
  if (ancestors.length > 0) {
    meta("РОДИТЕЛЬ", ancestors.map((ancestor) => `${ancestor.label} (${stateLabel(nodeState(ancestor, settings, source))})`).join(" / "));
  }
  if (node.kind === "entry") {
    if (node.description) meta("ЗНАЧЕНИЕ", node.description);
    const parent = parentOf(node, source, settings);
    if (parent && showNeighbors) {
      const index = parent.children.findIndex((child) => child.id === node.id);
      const context = parent.children.slice(Math.max(0, index - 1), index + 2);
      if (context.length > 1) {
        lines.push(theme.fg("muted", "СОСЕДНИЕ ЗАПИСИ"));
        for (const sibling of context) {
          const marker = sibling.id === node.id ? theme.fg("accent", "→ ") : "  ";
          const color = sibling.id === node.id ? "text" : "muted";
          lines.push(`${marker}${theme.fg(color, sibling.label)}`);
        }
      }
    }
  }
  if (node.kind === "scene") {
    const severity = node.label.match(/^(\d+)\.\s+(.+?)\s+[—–-]\s+(.+)$/);
    if (severity) {
      meta("УРОВЕНЬ", `${severity[1]} из 10`);
      if (node.description) meta("ЛЕКСИКА", node.description.replace(/^Лексика:\s*/u, ""));
    }
    const related = relatedDictionaryGroups(node, source);
    if (related.length > 0) {
      lines.push(theme.fg("muted", "СОВПАДЕНИЯ СО СЛОВАРЁМ"));
      for (const group of related) {
        lines.push(alignHeader(theme.fg("text", group.label), theme.fg("muted", dictionaryMatchCountLabel(group.matches)), width));
      }
    }
  }
  if (settings.skillEnabled === false && node.section !== "general") {
    meta("ПРИМЕНЕНИЕ", "выключено вместе со стилевым skill");
  }
  if (node.kind === "group" && node.children.length > 0) {
    const count = countState([node], settings, source);
    meta("ВКЛЮЧЕНО", `${count.enabled} из ${count.total}`);
  }
  const resourceMetadata: Partial<Record<string, { defaults: string; manual: string }>> = {
    "component:style-skill": {
      defaults: "включён в lite, full и ultra",
      manual: "общий выключатель доступен в любом активном режиме",
    },
    "component:dictionary-resource": {
      defaults: "набор записей зависит от режима",
      manual: "записи и группы доступны в lite, full и ultra",
    },
    "component:scenes-resource": {
      defaults: "набор сцен зависит от режима",
      manual: "сцены доступны в lite, full и ultra",
    },
    "component:huenitiv-resource": {
      defaults: "включены в ultra",
      manual: "доступны в lite, full и ultra",
    },
  };
  const selection = resourceMetadata[node.id];
  if (selection) {
    meta("ПО УМОЛЧАНИЮ", selection.defaults);
    meta("РУЧНОЙ ВЫБОР", selection.manual);
  }
  const sourceDocument = node.kind === "component" ? splitSourceDocument(node.markdown) : undefined;
  const displayMarkdown = node.kind === "scene"
    ? sceneBodyMarkdown(node.markdown)
    : sourceDocument?.body ?? node.markdown;
  const showMarkdown = displayMarkdown && node.kind !== "entry" &&
    (node.kind === "component" || node.kind === "group" || node.children.length === 0);
  if (showMarkdown) {
    if (sourceDocument?.frontmatter) {
      lines.push("");
      lines.push(theme.fg("muted", "МЕТАДАННЫЕ ФАЙЛА"));
      const metadata = sourceDocument.frontmatter.split("\n");
      for (let index = 0; index < metadata.length; index += 1) {
        if (metadata[index] !== "description: >") {
          lines.push(theme.fg("text", metadata[index]));
          continue;
        }
        lines.push(theme.fg("text", "description:"));
        const description: string[] = [];
        while (index + 1 < metadata.length && /^\s/u.test(metadata[index + 1])) {
          description.push(metadata[index + 1].replace(/^ {2}/u, ""));
          index += 1;
        }
        const quote = description.map((line) => `> ${line}`).join("\n");
        lines.push(...new Markdown(quote, 0, 0, getMarkdownTheme()).render(Math.max(1, width)));
      }
    }
    if (node.kind === "scene") {
      lines.push(theme.fg("muted", /^\s*-\s+(?:lite|full|ultra):/mu.test(displayMarkdown) ? "ПРИМЕРЫ ОТВЕТОВ" : "ПРИМЕР ОТВЕТА"));
    } else if (node.kind === "component") {
      lines.push("");
      lines.push(theme.fg("muted", "СОДЕРЖИМОЕ ФАЙЛА"));
    } else if (node.kind === "group") {
      lines.push("");
      lines.push(theme.fg("muted", "ТЕКСТ РАЗДЕЛА"));
    } else {
      lines.push("");
    }
    lines.push(...new Markdown(reflowMarkdownPreview(displayMarkdown), 0, 0, getMarkdownTheme()).render(Math.max(1, width)));
  }
  return lines.flatMap((line) => line === "" ? [""] : wrapTextWithAnsi(line, Math.max(1, width)));
}

function searchNodes(query: string, source: StyleSource, settings: StoredSettings): ConfigNode[] {
  const needle = query.trim().toLocaleLowerCase("ru-RU");
  if (!needle) return [];
  const nodes = SETTINGS_SECTIONS.flatMap((section) => flattenNodes(sectionRoots(section, settings, source)));
  const unique = new Map<string, { node: ConfigNode; score: number }>();
  for (const node of nodes) {
    const label = node.label.toLocaleLowerCase("ru-RU");
    const aliases = node.aliases.join("\n").toLocaleLowerCase("ru-RU");
    const body = [node.description, node.children.length === 0 ? node.markdown : "", node.path]
      .join("\n").toLocaleLowerCase("ru-RU");
    if (!label.includes(needle) && !aliases.includes(needle) && !body.includes(needle)) continue;
    const score = label === needle ? 4 : label.includes(needle) ? 3 : aliases.includes(needle) ? 2 : 1;
    if (!unique.has(node.id)) unique.set(node.id, { node, score });
  }
  return [...unique.values()]
    .sort((left, right) => right.score - left.score || left.node.path.localeCompare(right.node.path) || left.node.line - right.node.line)
    .map(({ node }) => node);
}

function footerLine(actions: Array<[string, string]>, width: number, theme: SettingsTheme, includeHelp = true): string {
  const help: [string, string] = ["?", "помощь"];
  const complete = !includeHelp || actions.some(([key]) => key.includes("?")) ? actions : [...actions, help];
  const rendered = complete.map(([key, description]) => `${theme.fg("accent", theme.bold(key))} ${theme.fg("muted", description)}`);
  const separator = theme.fg("muted", " / ");
  let value = rendered.join(separator);
  if (visibleWidth(value) > width) {
    const required = rendered.at(-1);
    const fitted: string[] = [];
    for (const action of rendered.slice(0, -1)) {
      const candidate = [...fitted, action, ...(required ? [required] : [])].join(separator);
      if (visibleWidth(candidate) <= width) fitted.push(action);
    }
    if (required) fitted.push(required);
    value = truncateToWidth(fitted.join(separator), width, "");
  }
  return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(value)) / 2))) + value;
}

function togglePatch(node: ConfigNode, settings: StoredSettings, source: StyleSource): SettingsPatch | undefined {
  if (node.id === "setting:tier") {
    const values: StoredTier[] = ["normal", "lite", "full", "ultra"];
    return { tier: values[(values.indexOf(settings.tier) + 1) % values.length] };
  }
  if (node.id === "setting:preset") {
    const customSources = settings.selectedSections !== undefined || Object.keys(settings.itemOverrides ?? {}).length > 0;
    return !customSources
      ? { selectedSections: selectedSectionIds(settings, source) }
      : { selectedSections: null, itemOverrides: null };
  }
  if (node.id === "component:style-skill") return { skillEnabled: settings.skillEnabled === false };

  const targetEnabled = nodeState(node, settings, source) !== "enabled";
  const dictionaryEntries = node.id === "component:dictionary-resource"
    ? flattenNodes(source.roots.dictionary).filter((item) => item.kind === "entry")
    : flattenNodes([node]).filter((item) => item.kind === "entry");
  if (dictionaryEntries.length > 0) {
    const overrides = { ...(settings.itemOverrides ?? {}) };
    for (const entry of dictionaryEntries) {
      if (targetEnabled === inheritedEntryEnabled(entry, settings, source)) delete overrides[entry.id];
      else overrides[entry.id] = targetEnabled;
    }
    return { itemOverrides: Object.keys(overrides).length > 0 ? overrides : null };
  }

  const sceneNodes = node.id === "component:scenes-resource"
    ? flattenNodes(source.roots.scenes).filter((item) => item.kind === "scene")
    : flattenNodes([node]).filter((item) => item.kind === "scene");
  const optionIds = sceneNodes.map((item) => item.optionId).filter((id): id is string => id !== undefined);
  if (optionIds.length > 0) {
    const selected = new Set(selectedSectionIds(settings, source));
    for (const id of optionIds) targetEnabled ? selected.add(id) : selected.delete(id);
    return { selectedSections: [...selected] };
  }
  if (node.optionId) {
    const selected = new Set(selectedSectionIds(settings, source));
    targetEnabled ? selected.add(node.optionId) : selected.delete(node.optionId);
    return { selectedSections: [...selected] };
  }
  return undefined;
}

type SettingsComponentOptions = {
  source: StyleSource;
  getSettings: () => StoredSettings;
  mutate: (patch: SettingsPatch) => Promise<void>;
  tui: { terminal: { rows: number }; requestRender(): void };
  theme: SettingsTheme;
  border: (text: string) => string;
  done: () => void;
  notify: (message: string, level: "info" | "warning" | "error") => void;
};

export function createStyleSettingsComponent(options: SettingsComponentOptions) {
  const { source, tui, theme, border } = options;
  let section: SettingsSection = "general";
  let focus: "search" | "list" | "detail" = "list";
  let narrowDetail = false;
  let focusMode: "list" | "detail" | undefined;
  let showHelp = false;
  let helpScroll = 0;
  let lastHelpMaxScroll = 0;
  let searchActive = false;
  let searchInputFocused = false;
  const searchInput = new Input();
  let componentFocused = false;
  let selected = 0;
  let listScroll = 0;
  let detailScroll = 0;
  let applying = false;
  let lastSplit = false;
  let lastDetailPage = 1;
  let lastDetailMaxScroll = 0;
  const expanded = new Set<string>();
  for (const root of [...source.roots.dictionary, ...source.roots.scenes]) expanded.add(root.id);

  const settings = () => options.getSettings();
  const searchQuery = () => searchInput.getValue();
  const results = () => searchNodes(searchQuery(), source, settings());
  const rows = (): TreeRow[] => searchActive && searchQuery()
    ? results().map((node) => ({ node, depth: 0 }))
    : visibleTreeRows(sectionRoots(section, settings(), source), expanded);
  const selectedNode = () => rows()[Math.min(selected, Math.max(0, rows().length - 1))]?.node;
  const clamp = () => {
    selected = Math.min(Math.max(0, selected), Math.max(0, rows().length - 1));
    detailScroll = Math.min(Math.max(0, detailScroll), lastDetailMaxScroll);
  };
  const request = () => { clamp(); tui.requestRender(); };
  const apply = (node: ConfigNode) => {
    if (applying) return;
    const patch = togglePatch(node, settings(), source);
    if (!patch) return;
    applying = true;
    void options.mutate(patch).catch((error) => {
      options.notify(`Не удалось изменить настройки Pohuy: ${String(error)}`, "error");
    }).finally(() => {
      applying = false;
      request();
    });
  };
  const selectSection = (next: SettingsSection) => {
    if (section === next) return;
    section = next;
    selected = 0;
    listScroll = 0;
    detailScroll = 0;
    focus = "list";
    narrowDetail = false;
    focusMode = undefined;
    request();
  };
  const cycleSection = (delta: -1 | 1) => {
    const index = SETTINGS_SECTIONS.indexOf(section);
    selectSection(SETTINGS_SECTIONS[(index + delta + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length]);
  };
  const reveal = (node: ConfigNode) => {
    section = node.section;
    searchActive = false;
    searchInputFocused = false;
    searchInput.setValue("");
    focus = "list";
    for (const ancestor of ancestorChain(node, source, settings())) expanded.add(ancestor.id);
    const revealed = visibleTreeRows(sectionRoots(section, settings(), source), expanded);
    selected = Math.max(0, revealed.findIndex((row) => row.node.id === node.id));
    listScroll = Math.max(0, selected - 2);
    detailScroll = 0;
    request();
  };

  const helpPanel = (width: number, height: number): string[] => {
    const inner = Math.max(0, width - 2);
    const contentWidth = Math.max(1, inner - 2);
    const sections: Array<{ title: string; entries: Array<[string, string]> }> = [
      { title: "Навигация", entries: [["↑↓ / j k", "выбор или прокрутка активной панели"], ["Shift+J/K", "прокрутка противоположной панели"], ["PgUp/PgDn", "прокрутка страницей"], ["←→ / h l", "дерево: родитель, свернуть или раскрыть"], ["Tab / Shift+Tab", "переключить панели; в узком виде открыть или закрыть карточку"]] },
      { title: "Вид", entries: [["f", "развернуть активную панель или вернуть две панели"], ["?", "открыть или закрыть эту панель"], ["1 2 3 4", "Общие, Skill, Словарь, Сцены"]] },
      { title: "Действия", entries: [["Space", "переключить настройку, запись, группу или сцену"], ["Enter", "открыть ресурс, карточку или результат поиска"], ["c", "скопировать путь источника"], ["/", "поиск по всем вкладкам"]] },
      { title: "Поиск и выход", entries: [["Enter", "показать найденный элемент в дереве"], ["Backspace", "удалить символ поиска"], ["Esc", "очистить поиск, свернуть панель или закрыть меню"], ["Ctrl+C", "закрыть меню"]] },
    ];
    const logical: string[] = [];
    for (const section of sections) {
      if (logical.length > 0) logical.push("");
      logical.push(theme.fg("accent", theme.bold(section.title)));
      for (const [key, description] of section.entries) {
        const prefix = `${theme.fg("accent", theme.bold(fitCell(key, 16)))} `;
        const wrapped = wrapTextWithAnsi(theme.fg("muted", description), Math.max(1, contentWidth - 17));
        wrapped.forEach((line, index) => {
          logical.push(`${index === 0 ? prefix : " ".repeat(17)}${line}`);
        });
      }
    }
    const bodyHeight = Math.max(1, height - 6);
    lastHelpMaxScroll = Math.max(0, logical.length - bodyHeight);
    helpScroll = Math.min(helpScroll, lastHelpMaxScroll);
    const visible = logical.slice(helpScroll, helpScroll + bodyHeight);
    const top = border(`┌${"─".repeat(inner)}┐`);
    const horizontal = border(`├${"─".repeat(inner)}┤`);
    const bottom = border(`└${"─".repeat(inner)}┘`);
    const outer = (content: string) => `${border("│")} ${fitCell(content, contentWidth)} ${border("│")}`;
    return fitSettingsRender([
      top,
      outer(alignHeader(theme.fg("accent", theme.bold("Pohuy: клавиши")), theme.fg("muted", `${helpScroll + 1}-${Math.min(logical.length, helpScroll + bodyHeight)}/${logical.length}`), contentWidth)),
      horizontal,
      ...Array.from({ length: bodyHeight }, (_, index) => outer(visible[index] ?? "")),
      horizontal,
      outer(footerLine([["? Esc", "закрыть"]], contentWidth, theme)),
      bottom,
    ], width, height);
  };

  const panelListLines = (width: number, height: number): string[] => {
    const currentRows = rows();
    if (currentRows.length === 0) return [theme.fg("muted", searchActive ? "Совпадений нет." : "Элементов нет.")];
    if (selected < listScroll) listScroll = selected;
    if (selected >= listScroll + height) listScroll = selected - height + 1;
    const visible = currentRows.slice(listScroll, listScroll + height);
    return visible.map((row, offset) => {
      const index = listScroll + offset;
      const active = index === selected;
      const node = row.node;
      const state = nodeState(node, settings(), source);
      const cursor = active ? theme.fg("accent", "→ ") : "  ";
      const indent = "  ".repeat(row.depth);
      const fold = node.children.length > 0 ? (expanded.has(node.id) ? "▾ " : "▸ ") : "";
      const labelColor = state === "disabled" ? "muted" : "text";
      const prefix = node.kind === "setting" ? theme.fg("accent", "•") : checkbox(state, theme);
      const left = `${cursor}${indent}${prefix} ${fold}${theme.fg(labelColor, active ? theme.bold(node.label) : node.label)}`;
      const counts = node.children.length > 0 && node.kind !== "component" ? countState([node], settings(), source) : undefined;
      const right = searchActive
        ? sourceLocation(node)
        : counts && counts.total > 0 ? `${counts.enabled}/${counts.total}` : "";
      const line = alignHeader(left, theme.fg("muted", right), width);
      return active ? theme.bg("selectedBg", fitCell(line, width)) : truncateToWidth(line, width, "");
    });
  };

  const render = (width: number): string[] => {
    const targetShellHeight = Math.max(1, Math.floor(options.tui.terminal.rows * 0.6));
    if (width < 4 || targetShellHeight < 4) {
      return fitSettingsRender(
        [tabsLine(section, theme), ...Array.from({ length: targetShellHeight - 1 }, () => "")],
        width,
        targetShellHeight,
      );
    }
    const shellWidth = width;
    if (showHelp) return helpPanel(shellWidth, targetShellHeight);
    const inner = Math.max(0, shellWidth - 2);
    lastSplit = inner >= 116;
    if (lastSplit) narrowDetail = false;
    const split = lastSplit && focusMode === undefined;
    if (!split && focus === "detail" && focusMode !== "detail" && !narrowDetail) focus = "list";
    const leftWidth = split ? Math.max(50, Math.floor((inner - 1) * 0.42)) : inner;
    const rightWidth = split ? inner - leftWidth - 1 : 0;
    const leftContentWidth = Math.max(1, leftWidth - 2);
    const rightContentWidth = Math.max(1, rightWidth - 2);
    const singleContentWidth = Math.max(1, inner - 2);
    const searchMatches = searchActive ? results().length : 0;
    const sectionNodes = sectionRoots(section, settings(), source);
    const sectionCount = section === "skill"
      ? (() => {
          const components = flattenNodes(sectionNodes).filter((candidate) => candidate.kind === "component");
          return {
            enabled: components.filter((candidate) => nodeState(candidate, settings(), source) !== "disabled").length,
            total: components.length,
          };
        })()
      : countState(sectionNodes, settings(), source);
    const status = searchActive
      ? `найдено: ${searchMatches}`
      : section === "general" ? `режим: ${settings().tier}` : `включено: ${sectionCount.enabled}/${sectionCount.total}`;
    const searchMaxWidth = Math.max(4, Math.min(28, Math.floor(singleContentWidth * 0.24)));
    const search = searchControl(searchInput, searchActive, searchMaxWidth, theme, componentFocused && searchInputFocused);    const rightHeader = `${search} ${theme.fg("muted", status)}`;
    const header = alignHeader(tabsLine(section, theme), rightHeader, singleContentWidth);
    const top = border(`┌${"─".repeat(inner)}┐`);
    const bottom = border(`└${"─".repeat(inner)}┘`);
    const outer = (content: string) => `${border("│")} ${fitCell(content, singleContentWidth)} ${border("│")}`;
    const fullHorizontal = border(`├${"─".repeat(inner)}┤`);
    const splitStart = split
      ? border(`├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`)
      : fullHorizontal;
    const splitMiddle = split
      ? border(`├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`)
      : fullHorizontal;
    const splitEnd = split
      ? border(`├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`)
      : fullHorizontal;
    const joined = (left: string, right: string) => `${border("│")} ${fitCell(left, leftContentWidth)} ${border("│")} ${fitCell(right, rightContentWidth)} ${border("│")}`;
    const title = searchActive && searchQuery() ? "РЕЗУЛЬТАТЫ ПОИСКА" : SETTINGS_SECTION_LABELS[section].toUpperCase();
    const node = selectedNode();
    const listTitle = theme.fg(focus === "list" ? "accent" : "muted", theme.bold(title));
    const detailTitle = theme.fg(focus === "detail" ? "accent" : "muted", theme.bold(searchActive ? "СОВПАДЕНИЕ" : section === "skill" ? "SKILL" : node?.kind === "scene" ? "СЦЕНА" : "ЭЛЕМЕНТ"));
    if (targetShellHeight < 10) {
      const summary = node ? `${node.label} / ${stateLabel(nodeState(node, settings(), source))}` : "Элементов нет.";
      const compact = targetShellHeight >= 8
        ? [top, outer(tabsLine(section, theme)), fullHorizontal, outer(summary), outer(node ? sourceLocation(node) : ""), fullHorizontal, outer(footerLine([["Esc", "закрыть"]], singleContentWidth, theme)), bottom]
        : targetShellHeight >= 7
          ? [top, outer(tabsLine(section, theme)), fullHorizontal, outer(summary), fullHorizontal, outer(footerLine([["Esc", "закрыть"]], singleContentWidth, theme)), bottom]
          : targetShellHeight >= 6
            ? [top, outer(tabsLine(section, theme)), fullHorizontal, outer(summary), outer(footerLine([["Esc", "закрыть"]], singleContentWidth, theme)), bottom]
            : targetShellHeight >= 5
              ? [top, outer(tabsLine(section, theme)), outer(summary), outer(footerLine([["Esc", "закрыть"]], singleContentWidth, theme)), bottom]
              : [top, outer(tabsLine(section, theme)), outer(summary), bottom];
      return fitSettingsRender(compact, shellWidth, targetShellHeight);
    }
    const overhead = 8;
    const availableBody = Math.max(1, targetShellHeight - overhead);
    const bodyHeight = availableBody;
    let contentLines: string[];

    if (!split && (narrowDetail || focusMode === "detail") && node) {
      const details = detailLines(node, singleContentWidth, settings(), source, theme, true);
      lastDetailPage = bodyHeight;
      lastDetailMaxScroll = Math.max(0, details.length - bodyHeight);
      detailScroll = Math.min(detailScroll, lastDetailMaxScroll);
      const visibleDetails = details.slice(detailScroll, detailScroll + bodyHeight);
      const detailRange = details.length > bodyHeight
        ? `${detailScroll + 1}-${Math.min(details.length, detailScroll + bodyHeight)}/${details.length}`
        : "";
      contentLines = [
        top,
        outer(theme.fg("accent", `${SETTINGS_SECTION_LABELS[section]} / ${node.label}`)),
        fullHorizontal,
        outer(alignHeader(theme.fg("accent", theme.bold("ПОДРОБНОСТИ")), theme.fg("muted", detailRange), singleContentWidth)),
        fullHorizontal,
        ...Array.from({ length: bodyHeight }, (_, index) => outer(visibleDetails[index] ?? "")),
        fullHorizontal,
        outer(footerLine([
          ["↑↓", "прокрутка"],
          [focusMode === "detail" ? "f/Esc" : "Tab/Backspace/Esc", focusMode === "detail" ? "вернуть две панели" : "к дереву"],
          ...(canToggleNode(node) ? [["Space", "вкл/выкл"] as [string, string]] : []),
          ...(openSectionFor(node) ? [["Enter", "открыть"] as [string, string]] : []),
          ["c", "путь"],
        ], singleContentWidth, theme)),
        bottom,
      ];
    } else if (split) {
      const list = panelListLines(leftContentWidth, bodyHeight);
      const details = node ? detailLines(node, rightContentWidth, settings(), source, theme) : [];
      lastDetailPage = bodyHeight;
      lastDetailMaxScroll = Math.max(0, details.length - bodyHeight);
      detailScroll = Math.min(detailScroll, lastDetailMaxScroll);
      const visibleDetails = details.slice(detailScroll, detailScroll + bodyHeight);
      const listRange = rows().length > bodyHeight
        ? `${listScroll + 1}-${Math.min(rows().length, listScroll + bodyHeight)}/${rows().length}`
        : "";
      const detailRange = details.length > bodyHeight
        ? `${detailScroll + 1}-${Math.min(details.length, detailScroll + bodyHeight)}/${details.length}`
        : "";
      const listHeading = alignHeader(listTitle, theme.fg("muted", listRange), leftContentWidth);
      const detailHeading = alignHeader(detailTitle, theme.fg("muted", detailRange), rightContentWidth);
      const footerActions: Array<[string, string]> = searchActive
        ? focus === "search"
          ? [["Tab", "результаты"], ["Enter", "результаты"], ["Esc", "очистить"]]
          : focus === "detail"
          ? [["Tab", "поиск"], ["Shift+Tab", "результаты"], ["↑↓", "прокрутка"], ["c", "копировать путь"], ["Esc", "очистить"]]
            : [["Tab", "подробности"], ["Shift+Tab", "поиск"], ["↑↓", "результат"], ...(node && canToggleNode(node) ? [["Space", toggleFooterDescription(node)] as [string, string]] : []), ["Enter", "показать в дереве"], ["c", "копировать путь"], ["Esc", "очистить"]]
        : focus === "detail"
          ? [["Tab", "к дереву"], ["↑↓", "прокрутка"], ...(node && canToggleNode(node) ? [["Space", toggleFooterDescription(node)] as [string, string]] : []), ...(node && openSectionFor(node) ? [["Enter", "открыть"] as [string, string]] : []), ["c", "копировать путь"], ["Esc", "закрыть"]]
          : [["Tab", "подробности"], ["↑↓", "выбор"], ...treeFooterActions(node, expanded, Boolean(node && ancestorChain(node, source, settings()).length)), ...(node && canToggleNode(node) ? [["Space", toggleFooterDescription(node)] as [string, string]] : []), ...(node && openSectionFor(node) ? [["Enter", "открыть"] as [string, string]] : []), ["c", "копировать путь"], ["[ ]", "раздел"], ["Esc", "закрыть"]];
      contentLines = [
        top,
        outer(header),
        splitStart,
        joined(listHeading, detailHeading),
        splitMiddle,
        ...Array.from({ length: bodyHeight }, (_, index) => joined(list[index] ?? "", visibleDetails[index] ?? "")),
        splitEnd,
        outer(footerLine(footerActions, singleContentWidth, theme)),
        bottom,
      ];
    } else {
      const listHeight = Math.max(1, bodyHeight - 1);
      const list = panelListLines(singleContentWidth, listHeight);
      lastDetailPage = bodyHeight;
      lastDetailMaxScroll = 0;
      const selectedSummary = node
        ? metadataLine("ВЫБРАНО", `${node.label} / ${stateLabel(nodeState(node, settings(), source))} / ${sourceLocation(node)}`, singleContentWidth, theme)
        : "";
      const titleRight = searchActive
        ? `${searchControl(searchInput, true, searchMaxWidth, theme, componentFocused && searchInputFocused)} ${theme.fg("muted", `найдено: ${searchMatches}`)}`
        : searchControl(searchInput, false, searchMaxWidth, theme);
      const narrowTitle = searchActive && visibleWidth(listTitle) + visibleWidth(titleRight) + 1 > singleContentWidth
        ? fitCell(titleRight, singleContentWidth, "right")
        : alignHeader(listTitle, titleRight, singleContentWidth);
      contentLines = [
        top,
        outer(tabsLine(section, theme)),
        fullHorizontal,
        outer(narrowTitle),
        fullHorizontal,
        ...Array.from({ length: listHeight }, (_, index) => outer(list[index] ?? "")),
        outer(selectedSummary),
        fullHorizontal,
        outer(footerLine(searchActive
          ? [["↑↓", "результат"], ["Enter", "показать"], ...(node && canToggleNode(node) ? [["Space", "вкл/выкл"] as [string, string]] : []), ["c", "путь"], ["Esc", "очистить"]]
          : [["↑↓", "выбор"], ["Tab/Enter", node && openSectionFor(node) ? "открыть" : "карточка"], ...treeFooterActions(node, expanded, Boolean(node && ancestorChain(node, source, settings()).length)), ...(node && canToggleNode(node) ? [["Space", "вкл/выкл"] as [string, string]] : []), ["c", "путь"], ["[ ]", "раздел"], ["Esc", "закрыть"]], singleContentWidth, theme)),
        bottom,
      ];
    }
    return fitSettingsRender(contentLines, shellWidth, targetShellHeight);
  };

  return {
    get focused() {
      return componentFocused;
    },
    set focused(value: boolean) {
      componentFocused = value;
      searchInput.focused = value && searchInputFocused;
    },
    render,
    invalidate() {
      searchInput.invalidate();
    },
    handleInput(data: string) {
      if (showHelp) {
        if (data === "?" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          showHelp = false;
          helpScroll = 0;
        } else if (matchesKey(data, Key.up) || data === "k") {
          helpScroll = Math.max(0, helpScroll - 1);
        } else if (matchesKey(data, Key.down) || data === "j") {
          helpScroll = Math.min(lastHelpMaxScroll, helpScroll + 1);
        } else {
          return;
        }
        request();
        return;
      }
      if (searchActive) {
        if (matchesKey(data, Key.escape)) {
          searchActive = false;
          searchInputFocused = false;
          searchInput.setValue("");
          focus = "list";
          selected = 0;
          request();
          return;
        }
        const reserved = matchesKey(data, Key.enter) || matchesKey(data, Key.tab) ||
          matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up) ||
          matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) ||
          matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("c"));
        if (searchInputFocused && !reserved) {
          searchInput.handleInput(data);
          selected = 0;
          request();
          return;
        }
      }
      if (data === "?") {
        showHelp = !showHelp;
        helpScroll = 0;
        request();
        return;
      }
      if ((narrowDetail || focusMode) && (matchesKey(data, Key.backspace) || matchesKey(data, Key.escape))) {
        narrowDetail = false;
        focusMode = undefined;
        detailScroll = 0;
        request();
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        options.done();
        return;
      }
      if (applying) return;
      if (data === "/") {
        searchActive = true;
        searchInputFocused = true;
        focus = "search";
        selected = 0;
        request();
        return;
      }
      if (matchesKey(data, Key.tab) && !lastSplit) {
        if (narrowDetail) {
          narrowDetail = false;
          focus = "list";
        } else if (focus === "search") {
          focus = "list";
          searchInputFocused = false;
        } else if (selectedNode()) {
          narrowDetail = true;
          focus = "detail";
          detailScroll = 0;
        }
        request();
        return;
      }
      if (matchesKey(data, Key.shift("tab")) && !lastSplit) {
        if (narrowDetail) {
          narrowDetail = false;
          focus = "list";
        } else if (searchActive) {
          focus = "search";
          searchInputFocused = true;
        } else if (selectedNode()) {
          narrowDetail = true;
          focus = "detail";
          detailScroll = 0;
        }
        request();
        return;
      }
      if (matchesKey(data, Key.tab)) {
        const order: Array<"search" | "list" | "detail"> = searchActive
          ? lastSplit ? ["search", "list", "detail"] : ["search", "list"]
          : lastSplit ? ["list", "detail"] : ["list"];
        focus = order[(order.indexOf(focus) + 1 + order.length) % order.length];
        searchInputFocused = focus === "search";
        request();
        return;
      }
      if (matchesKey(data, Key.shift("tab"))) {
        const order: Array<"search" | "list" | "detail"> = searchActive
          ? lastSplit ? ["search", "list", "detail"] : ["search", "list"]
          : lastSplit ? ["list", "detail"] : ["list"];
        focus = order[(order.indexOf(focus) - 1 + order.length) % order.length];
        searchInputFocused = focus === "search";
        request();
        return;
      }
      if (!searchActive && data === "[") { cycleSection(-1); return; }
      if (!searchActive && data === "]") { cycleSection(1); return; }
      if (!searchActive && /^[1-4]$/u.test(data)) {
        selectSection(SETTINGS_SECTIONS[Number(data) - 1]);
        return;
      }
      if (!searchActive && data === "f" && lastSplit) {
        focusMode = focusMode ? undefined : focus === "detail" ? "detail" : "list";
        narrowDetail = false;
        request();
        return;
      }
      const node = selectedNode();
      if (matchesKey(data, Key.enter) && node) {
        if (searchActive && searchQuery()) reveal(node);
        else if (openSectionFor(node)) selectSection(openSectionFor(node)!);
        else if (!lastSplit) { narrowDetail = true; detailScroll = 0; request(); }
        else if (focus === "list") { focus = "detail"; detailScroll = 0; request(); }
        return;
      }
      if ((data === "c" || data === "C") && node) {
        const location = sourceLocation(node);
        void copyToClipboard(location)
          .then(() => options.notify(`Скопировано: ${location}`, "info"))
          .catch((error) => options.notify(`Не удалось скопировать путь: ${String(error)}`, "error"));
        return;
      }
      if (matchesKey(data, Key.space) && node) { apply(node); return; }
      const page = Math.max(1, lastDetailPage - 1);
      const shiftedUp = data === "K" || matchesKey(data, Key.shift("k"));
      const shiftedDown = data === "J" || matchesKey(data, Key.shift("j"));
      if (lastSplit && (shiftedUp || shiftedDown)) {
        if (focus === "detail" || focusMode === "detail") {
          selected = shiftedUp ? Math.max(0, selected - 1) : Math.min(Math.max(0, rows().length - 1), selected + 1);
          detailScroll = 0;
        } else {
          detailScroll = shiftedUp
            ? Math.max(0, detailScroll - 1)
            : Math.min(lastDetailMaxScroll, detailScroll + 1);
        }
        request();
        return;
      }
      if (focus === "detail" || narrowDetail || focusMode === "detail") {
        if (matchesKey(data, Key.up) || data === "k") detailScroll = Math.max(0, detailScroll - 1);
        else if (matchesKey(data, Key.down) || data === "j") detailScroll = Math.min(lastDetailMaxScroll, detailScroll + 1);
        else if (matchesKey(data, Key.pageUp)) detailScroll = Math.max(0, detailScroll - page);
        else if (matchesKey(data, Key.pageDown)) detailScroll = Math.min(lastDetailMaxScroll, detailScroll + page);
        else return;
        request();
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") selected = Math.max(0, selected - 1);
      else if (matchesKey(data, Key.down) || data === "j") {
        if (searchActive) {
          searchInputFocused = false;
          focus = "list";
        }
        selected = Math.min(Math.max(0, rows().length - 1), selected + 1);
      }
      else if (matchesKey(data, Key.pageUp)) selected = Math.max(0, selected - page);
      else if (matchesKey(data, Key.pageDown)) selected = Math.min(Math.max(0, rows().length - 1), selected + page);
      else if (!searchActive && (matchesKey(data, Key.left) || data === "h") && node) {
        if (node.children.length > 0 && expanded.has(node.id)) {
          expanded.delete(node.id);
        } else {
          const parent = parentOf(node, source, settings());
          if (!parent) return;
          selected = rows().findIndex((row) => row.node.id === parent.id);
        }
      }
      else if (!searchActive && (matchesKey(data, Key.right) || data === "l") && node?.children.length) {
        if (!expanded.has(node.id)) {
          expanded.add(node.id);
        } else {
          const firstChild = node.children[0];
          selected = rows().findIndex((row) => row.node.id === firstChild.id);
        }
      }
      else return;
      detailScroll = 0;
      request();
    },
  };
}


