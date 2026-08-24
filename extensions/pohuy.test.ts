import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildStylePolicy,
  buildStylePrompt,
  buildStylePromptReport,
  createStyleSettingsComponent,
  diffStoredSettings,
  fitSettingsRender,
  loadStyleSource,
  mergeStoredSettings,
  normalizeStoredSettings,
  placeStylePromptAtAppendBoundary,
  selectTierVariant,
  stripManagedStyleBlocks,
} from "./pohuy.js";
import { SETTINGS_PATH } from "./pohuy/settings-store.js";

const START = "<!-- POHUY:START -->";
const END = "<!-- POHUY:END -->";

function markerCount(value: string): number {
  return value.split(START).length - 1;
}

test("replaces every previously managed block with one current block", () => {
  const base = [
    "Base prompt",
    `${START}\nold policy\n${END}`,
    "Project context",
    `${START}\nolder policy\n${END}`,
    "User append",
  ].join("\n\n");

  const result = placeStylePromptAtAppendBoundary(base, "User append", "current policy");

  assert.equal(markerCount(result), 1);
  assert.match(result, /Project context\n\n<!-- POHUY:START -->\ncurrent policy\n<!-- POHUY:END -->\n\nUser append$/);
  assert.doesNotMatch(result, /old(?:er)? policy/);
});

test("removes the managed block when normal mode is selected", () => {
  const base = `Base\n\n${START}\npolicy\n${END}\n\nAppend`;

  assert.equal(placeStylePromptAtAppendBoundary(base, "Append", undefined), "Base\n\nAppend");
});

test("removes an unterminated managed block", () => {
  const base = `Base\n\n${START}\nunterminated policy`;

  assert.equal(stripManagedStyleBlocks(base), "Base");
});

test("removes nested malformed and completed managed blocks", () => {
  const base = [
    "Base",
    `${START}\nunterminated policy`,
    `${START}\nmanaged policy\n${END}`,
    "Append",
  ].join("\n\n");

  assert.equal(stripManagedStyleBlocks(base), "Base");
});

test("preserves the append boundary while replacing an unterminated managed block", () => {
  const base = ["Base", `${START}\nunterminated policy`, "User append"].join("\n\n");

  const result = placeStylePromptAtAppendBoundary(base, "User append", "current policy");

  assert.equal(result, ["Base", `${START}\ncurrent policy\n${END}`, "User append"].join("\n\n"));
});

test("does not reformat prompts without completed managed blocks", () => {
  const base = "  Base with spaces  \n\n\nUnmanaged tail  ";

  assert.equal(stripManagedStyleBlocks(base), base);
});

test("removes adjacent completed blocks without leaving extra blank lines", () => {
  const base = `Base\n\n${START}\none\n${END}\n\n${START}\ntwo\n${END}\n\nAppend`;

  assert.equal(stripManagedStyleBlocks(base), "Base\n\nAppend");
});

test("preserves unrelated context while replacing a stale managed block", () => {
  const base = [
    "System persona",
    "## /project/AGENTS.md\n\nProject rule",
    `${START}\nstale policy\n${END}`,
    "Available skills",
    "User append",
  ].join("\n\n");

  const result = placeStylePromptAtAppendBoundary(base, "User append", "current policy");

  assert.match(result, /^System persona/);
  assert.match(result, /## \/project\/AGENTS\.md\n\nProject rule/);
  assert.match(result, /Available skills/);
  assert.match(result, /current policy/);
  assert.match(result, /User append$/);
  assert.doesNotMatch(result, /stale policy/);
});

test("reported full configuration removes only known overlaps and inactive tier variants", async () => {
  const source = await loadStyleSource();
  const selectedSections = [
    "skill:Словарь (рабочий минимум)",
    "slovar:Состояния и статусы",
    "slovar:Оценки и количества",
    "slovar:Сущности",
    "sceny:1. Триумф — взлетело лучше, чем ждали",
    "sceny:3. Мелочь — вопрос на пять минут",
    "sceny:4. Странность — непонятное поведение",
    "sceny:Ревью говнокода",
    "sceny:Флаки-тест третий день",
    "sceny:Дока врёт",
    "sceny:Легаси-археология",
    "sceny:Каскадный отказ",
    "sceny:Идея пользователя так себе — материм идею, не человека",
    "sceny:Триумф после долгого дебага",
  ];

  const policy = buildStylePolicy({ tier: "full", selectedSections }, source);
  assert.ok(policy);

  assert.doesNotMatch(policy, /\nСостояние:\n/);
  assert.doesNotMatch(policy, /\nСвязки и оценки:\n/);
  assert.equal(policy.match(/^## Состояния и статусы$/gm)?.length, 1);
  assert.equal(policy.match(/^## Оценки и количества$/gm)?.length, 1);
  assert.equal(policy.match(/^## Сущности$/gm)?.length, 1);
  assert.doesNotMatch(policy, /^- lite:/gm);
  assert.doesNotMatch(policy, /^- ultra:/gm);
  assert.match(policy, /^- full: «Опизденеть можно:/m);
  assert.match(policy, /Кластер ебашит, латенси в норме\.»\n- \*\*пиздато\*\*/);
  assert.match(policy, /^## Уровень: full$/m);
  assert.match(policy, /Примеры:\n- «Хуйня вопрос\./);
  assert.doesNotMatch(policy, /Default:|\/pohuy lite|нормальный режим|Уровень держится до смены|Полные примеры по каждой|Полная версия с маппингами|Полный арсенал образности|references\/(?:sceny|slovar)\.md/);
  assert.doesNotMatch(policy, /Scene examples are tone references|\| \*\*full\*\* \|/);
  assert.match(policy, /Сцены задают тон, а не готовый текст/);
  assert.match(policy, /### Триумф после долгого дебага/);
  assert.match(policy, /таймзона в CI/);
});

test("a dictionary entry keeps its exact source path and can be disabled alone", async () => {
  const source = await loadStyleSource();
  const imagery = source.roots.dictionary.find((node) => node.label.startsWith("Образность"));
  assert.ok(imagery);
  const entries = (nodes: typeof source.roots.dictionary): typeof source.roots.dictionary =>
    nodes.flatMap((node) => [node, ...entries(node.children)]);
  const item = entries([imagery]).find((node) => node.label === "опа! пиздрик");
  assert.ok(item);
  assert.equal(item.path, "references/slovar.md");
  const slovar = await readFile(new URL("../skills/pohuy/references/slovar.md", import.meta.url), "utf8");
  assert.match(slovar.split("\n")[item.line - 1] ?? "", /опа! пиздрик/);
  assert.ok(entries([imagery]).some((node) => node.label === "ебать-копать"));

  const policy = buildStylePolicy({
    tier: "full",
    selectedSections: [imagery.optionId!],
    itemOverrides: { [item.id]: false },
  }, source);
  assert.ok(policy);
  assert.doesNotMatch(policy, /опа! пиздрик/);
  assert.match(policy, /хуйня-муйня/);
});

test("an explicitly disabled term removes matching entries without altering unrelated prose", async () => {
  const source = await loadStyleSource();
  const entries = (nodes: typeof source.roots.dictionary): typeof source.roots.dictionary =>
    nodes.flatMap((node) => [node, ...entries(node.children)]);
  const item = entries(source.roots.dictionary).find((node) => node.label === "ебашит");
  assert.ok(item);

  const policy = buildStylePolicy({
    tier: "full",
    selectedSections: [
      "skill:Словарь (рабочий минимум)",
      "slovar:Состояния и статусы",
      "sceny:1. Триумф — взлетело лучше, чем ждали",
    ],
    itemOverrides: { [item.id]: false },
  }, source);

  assert.ok(policy);
  assert.doesNotMatch(policy, /^- (?:\*\*)?ебашит(?:\*\*)?\s+—/imu);
  assert.match(policy, /Ебашит так, что алерты от скуки уснули\./u);
  assert.match(policy, /Триумф — лучше, чем ждали \| охуенно, опизденеть можно, ебашит,/u);
});

test("disabling the style component preserves source selections", async () => {
  const source = await loadStyleSource();
  const settings = {
    tier: "ultra" as const,
    skillEnabled: false,
    selectedSections: ["sceny:Ревью говнокода"],
  };
  assert.equal(buildStylePolicy(settings, source), undefined);
  assert.deepEqual(settings.selectedSections, ["sceny:Ревью говнокода"]);
});

test("normalizes item overrides to meaningful deviations from inherited section state", async () => {
  const source = await loadStyleSource();
  const settings = normalizeStoredSettings({
    tier: "full",
    selectedSections: [
      "skill:Словарь (рабочий минимум)",
      "slovar:Состояния и статусы",
    ],
    itemOverrides: {
      "item:slovar:Состояния и статусы:ебашит": true,
      "item:slovar:Действия:проёб": true,
      "item:skill:Словарь (рабочий минимум):пиздрик": false,
      "item:slovar:Состояния и статусы:unknown": false,
    },
  }, source);

  assert.deepEqual(settings.itemOverrides, {
    "item:slovar:Действия:проёб": true,
    "item:skill:Словарь (рабочий минимум):пиздрик": false,
  });
});

test("huenitiv rules default to ultra and remain manually configurable in every active tier", async () => {
  const source = await loadStyleSource();
  const resource = source.roots.skill.find((node) => node.id === "component:huenitiv-resource");
  assert.ok(resource);
  assert.equal(resource.path, "references/huenitiv.md");
  assert.equal(resource.line, 1);

  const fullDefault = buildStylePolicy({ tier: "full" }, source);
  assert.ok(fullDefault);
  assert.doesNotMatch(fullDefault, /^# ХУЕНИТИВЫ/m);
  assert.equal(buildStylePromptReport({ tier: "full" }, source).huenitivEnabled, false);

  const ultraDefault = buildStylePolicy({ tier: "ultra" }, source);
  assert.ok(ultraDefault);
  assert.equal(ultraDefault.match(/^# ХУЕНИТИВЫ/m)?.length, 1);
  assert.match(ultraDefault, /зарядка-хуерядка/);
  assert.equal(buildStylePromptReport({ tier: "ultra" }, source).huenitivEnabled, true);

  for (const tier of ["lite", "full"] as const) {
    const manuallyEnabled = buildStylePolicy({ tier, selectedSections: ["huenitiv:rules"] }, source);
    assert.ok(manuallyEnabled);
    assert.match(manuallyEnabled, /^# ХУЕНИТИВЫ/m);
    assert.match(manuallyEnabled, /зарядка-хуерядка/);
    assert.doesNotMatch(manuallyEnabled, /Только в режиме \*\*ultra\*\*\./);
  }

  const migrated = normalizeStoredSettings({
    tier: "full",
    selectedSections: ["skill:Хуенитивы"],
  }, source);
  assert.deepEqual(migrated.selectedSections, ["huenitiv:rules"]);
  assert.match(buildStylePolicy(migrated, source) ?? "", /^# ХУЕНИТИВЫ/m);
});

test("prompt report measures the exact managed Pohuy block", async () => {
  const source = await loadStyleSource();
  const settings = { tier: "full" as const };
  const stylePrompt = buildStylePrompt(settings, source);
  const report = buildStylePromptReport(settings, source);

  assert.ok(stylePrompt);
  assert.equal(report.stylePrompt, stylePrompt);
  assert.equal(report.managedBlock, `${START}\n${stylePrompt}\n${END}`);
  assert.ok(report.managedBlock);
  assert.equal(report.managedCharacters, report.managedBlock.length);
  assert.equal(report.policyCharacters, buildStylePolicy(settings, source)?.length);
  assert.ok(report.managedCharacters > report.policyCharacters);
  assert.match(stylePrompt, /^Стиль ответов: Pohuy\./);
  assert.match(stylePrompt, /Не меняй вызовы и результаты инструментов/);
  assert.doesNotMatch(stylePrompt, /Active session style|Selected tier|Do not alter tool calls/);
});

test("keeps skipping an inactive tier variant across blank continuation lines", () => {
  const content = [
    "### Scene",
    "- lite: hidden opening",
    "  hidden continuation",
    "",
    "  hidden continuation after blank line",
    "- full: visible example",
    "",
    "Following paragraph",
  ].join("\n");

  assert.equal(
    selectTierVariant(content, "full"),
    ["### Scene", "- full: visible example", "", "Following paragraph"].join("\n"),
  );

  const trailingInactiveVariant = [
    "### Scene",
    "- lite: visible example",
    "- full: hidden example",
    "",
    "Following paragraph",
  ].join("\n");
  assert.equal(
    selectTierVariant(trailingInactiveVariant, "lite"),
    ["### Scene", "- lite: visible example", "", "Following paragraph"].join("\n"),
  );
});

test("preserves unrelated root and legacy Pohuy settings fields", () => {
  const root = {
    theme: "dark",
    pohuy: {
      tier: "full",
      basePrompt: "minimal",
      futureOption: true,
      selectedSections: ["old"],
    },
  };

  assert.deepEqual(mergeStoredSettings(root, { tier: "ultra", selectedSections: null }), {
    theme: "dark",
    pohuy: {
      tier: "ultra",
      basePrompt: "minimal",
      futureOption: true,
    },
  });
});

test("persists only fields changed from the latest stored settings", () => {
  assert.deepEqual(
    diffStoredSettings(
      { tier: "full", selectedSections: ["old"], itemOverrides: { keep: true } },
      { tier: "ultra", selectedSections: ["old"], itemOverrides: { keep: true } },
    ),
    { tier: "ultra" },
  );
  assert.deepEqual(
    diffStoredSettings(
      { tier: "full", selectedSections: ["old"], itemOverrides: { stale: false } },
      { tier: "full" },
    ),
    { selectedSections: null, itemOverrides: null },
  );
});

test("bounds settings output by terminal width and height", () => {
  const lines = ["123456", "abcdef", "third"];

  const fitted = fitSettingsRender(lines, 4, 2);
  assert.equal(fitted.length, 2);
  assert.ok(fitted.every((line) => visibleWidth(line) <= 4));
  assert.equal(visibleWidth(fitted[0]), 4);
  assert.equal(visibleWidth(fitted[1]), 4);
  assert.deepEqual(fitSettingsRender(lines, 0, 1), [""]);
  assert.deepEqual(fitSettingsRender(lines, 4, 0), []);
});

test("settings navigation keeps Tab inside the current section and uses available geometry", async () => {
  initTheme("dark");
  const source = await loadStyleSource();
  const identityTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  let requested = 0;
  const terminal = { rows: 50 };
  const component = (createStyleSettingsComponent as (options: unknown) => {
    render(width: number): string[];
    handleInput(data: string): void;
  })({
    source,
    getSettings: () => ({ tier: "full" }),
    mutate: async () => undefined,
    tui: { terminal, requestRender: () => { requested += 1; } },
    theme: identityTheme,
    border: (text: string) => text,
    done: () => undefined,
    notify: () => undefined,
  });

  const initial = component.render(170);
  assert.ok(initial.every((line) => visibleWidth(line) === 170));
  assert.equal(initial.length, Math.floor(terminal.rows * 0.6));
  assert.match(initial[1], /\[Общие\] Skill Словарь Сцены/);
  assert.match(initial.at(-2) ?? "", /Tab подробности/);
  assert.equal(initial.join("\n").match(/поиск/g)?.length, 1);
  assert.match(initial[2], /┬/);
  assert.match(initial[4], /┼/);
  assert.match(initial.at(-3) ?? "", /┴/);
  assert.match(initial.join("\n"), /Режим: full \(normal, lite, ultra\)/);
  assert.match(initial.join("\n"), /Итоговая инструкция: [\d\s ]+ симв\./);
  assert.doesNotMatch(initial.join("\n"), /Current mode:|Available values:|settings\.json:1/);
  assert.doesNotMatch(initial.join("\n"), /ПАКЕТ|ОБЛАСТЬ|ИТОГ/);
  const initialDetail = initial.slice(5, -3).map((line) => line.split("│")[2] ?? "");
  const metadataValueColumns = [
    ["СОСТОЯНИЕ", "включено"],
    ["ИСТОЧНИК", "settings.json"],
    ["ЧТО ДЕЛАЕТ", "normal"],
    ["ЗАГРУЖЕНО ИЗ", SETTINGS_PATH],
  ].map(([label, value]) => initialDetail.find((line) => line.includes(label))?.indexOf(value));
  assert.deepEqual([...new Set(metadataValueColumns)], [14]);

  component.handleInput("j");
  const promptPreview = component.render(170).join("\n");
  assert.match(promptPreview, /Итоговая инструкция Pohuy/);
  assert.match(promptPreview, /символов в блоке POHUY/);
  assert.match(promptPreview, /РАЗДЕЛЫ\s+1 из 29/);
  assert.match(promptPreview, /ХУЕНИТИВЫ\s+выключены/);
  assert.match(promptPreview, /НАБОР\s+стандартный для режима full/);
  assert.match(promptPreview, /ПРАВКИ\s+нет/);
  assert.doesNotMatch(promptPreview, /ВНЕ POHUY|ИСКЛЮЧЕНИЯ|1\/28;/);
  component.handleInput("k");

  component.handleInput("\t");
  const detailFocused = component.render(170);
  assert.equal(detailFocused.length, initial.length);
  assert.match(detailFocused[1], /\[Общие\] Skill Словарь Сцены/);
  assert.match(detailFocused.at(-2) ?? "", /Tab к дереву/);

  component.handleInput("\x1b[Z");
  assert.match(component.render(170).at(-2) ?? "", /Tab подробности/);

  component.handleInput("]");
  const skillSection = component.render(170);
  assert.match(skillSection[1], /Общие \[Skill\] Словарь Сцены/);
  assert.match(skillSection[1], /включено: \d\/4/);
  assert.equal(skillSection.length, initial.length);
  const skillList = skillSection.slice(5, -3).map((line) => line.split("│")[1] ?? "").join("\n");
  assert.match(skillList, /Стилевой skill/);
  assert.match(skillList, /Рабочий словарь/);
  assert.match(skillList, /Сцены/);
  assert.match(skillList, /Хуенитивы/);
  assert.doesNotMatch(skillList, /Словарь \(рабочий минимум\)/);
  const skillResource = skillSection.join("\n");
  assert.match(skillResource, /ИСТОЧНИК\s+SKILL\.md/);
  assert.doesNotMatch(skillResource, /SKILL\.md:1/);
  assert.match(skillResource, /ПО УМОЛЧАНИЮ\s+включён в lite, full и ultra/);
  assert.match(skillResource, /РУЧНОЙ ВЫБОР\s+общий выключатель доступен в любом активном режиме/);
  assert.match(skillResource, /МЕТАДАННЫЕ ФАЙЛА/);
  assert.match(skillResource, /name:.*pohuy/);
  assert.match(skillResource, /description:/);
  assert.doesNotMatch(skillResource, /description: >/);
  assert.match(skillResource, /СОДЕРЖИМОЕ ФАЙЛА/);

  component.handleInput("j");
  const dictionaryResource = component.render(170);
  assert.doesNotMatch(dictionaryResource.join("\n"), /ACTION/);
  const dictionaryCard = dictionaryResource.join("\n");
  assert.match(dictionaryCard, /ИСТОЧНИК\s+references\/slovar\.md/);
  assert.doesNotMatch(dictionaryCard, /references\/slovar\.md:1/);
  assert.match(dictionaryCard, /ПО УМОЛЧАНИЮ\s+набор записей зависит от режима/);
  assert.match(dictionaryCard, /РУЧНОЙ ВЫБОР\s+записи и группы доступны в lite, full и ultra/);
  assert.match(dictionaryCard, /СОДЕРЖИМОЕ ФАЙЛА/);
  assert.match(dictionaryCard, /Словарь: расширение/);
  assert.match(dictionaryResource.at(-2) ?? "", /Enter открыть/);
  assert.match(dictionaryResource.at(-2) ?? "", /c копировать путь/);
  component.handleInput("j");
  const scenesResource = component.render(170).join("\n");
  assert.match(scenesResource, /Примеры ответов для состояний проекта и типичных ситуаций\./);
  assert.match(scenesResource, /ИСТОЧНИК\s+references\/sceny\.md/);
  assert.doesNotMatch(scenesResource, /references\/sceny\.md:1/);
  assert.match(scenesResource, /ПО УМОЛЧАНИЮ\s+набор сцен зависит от режима/);
  assert.match(scenesResource, /РУЧНОЙ ВЫБОР\s+сцены доступны в lite, full и ultra/);
  assert.match(scenesResource, /СОДЕРЖИМОЕ ФАЙЛА/);
  assert.match(scenesResource, /Сцены: шкала состояний и эталонные примеры/);
  component.handleInput("j");
  const huenitivResource = component.render(170).join("\n");
  assert.match(huenitivResource, /ИСТОЧНИК\s+references\/huenitiv\.md/);
  assert.doesNotMatch(huenitivResource, /references\/huenitiv\.md:1/);
  assert.match(huenitivResource, /ПО УМОЛЧАНИЮ\s+включены в ultra/);
  assert.match(huenitivResource, /РУЧНОЙ ВЫБОР\s+доступны в lite, full и ultra/);
  assert.match(huenitivResource, /СОДЕРЖИМОЕ ФАЙЛА/);
  assert.match(huenitivResource, /зарядка.*хуерядка/);
  component.handleInput("k");
  component.handleInput("k");
  component.handleInput("\r");
  const expandedViewport = component.render(170);
  assert.match(expandedViewport[1], /Общие Skill \[Словарь\] Сцены/);
  assert.equal(expandedViewport.length, Math.floor(terminal.rows * 0.6));
  assert.ok(expandedViewport.every((line) => visibleWidth(line) === 170));
  for (const width of [118, 140, 170, 240]) {
    assert.ok(component.render(width).every((line) => visibleWidth(line) === width));
  }

  component.handleInput("/");
  const emptySearch = component.render(170);
  assert.match(emptySearch[1], /\[  \] найдено: 0 │$/);
  component.handleInput("d");
  const oneCharacterSearch = component.render(170);
  assert.match(oneCharacterSearch[1], /\[ d \] найдено:/);
  assert.match(oneCharacterSearch[1], /найдено: \d+ │$/);
  component.handleInput("\x7f");
  component.handleInput("/");
  component.handleInput("?");
  assert.match(component.render(170)[1], /\[ \/\? \] найдено: 0 │$/);
  component.handleInput("\x7f");
  component.handleInput("\x7f");
  for (const character of "пиздрик") component.handleInput(character);
  const populatedSearch = component.render(170);
  assert.match(populatedSearch[1], /\[ пиздрик \] найдено:/);
  assert.match(populatedSearch[1], /найдено: \d+ │$/);
  assert.equal(populatedSearch.length, emptySearch.length);
  component.handleInput("\x1b");
  component.render(170);

  component.handleInput("\t");
  for (let index = 0; index < 100; index += 1) component.handleInput("\x1b[6~");
  const scrollEnd = component.render(170);
  component.handleInput("\x1b[6~");
  assert.deepEqual(component.render(170), scrollEnd);

  terminal.rows = 4;
  const compact = component.render(60);
  assert.equal(compact.length, Math.floor(terminal.rows * 0.6));
  assert.ok(component.render(2).every((line) => visibleWidth(line) <= 2));
  assert.ok(requested >= 3);
});

test("settings UX supports opposite-pane scrolling, focus mode, help, and numeric tabs", async () => {
  initTheme("dark");
  const source = await loadStyleSource();
  const identityTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = (createStyleSettingsComponent as (options: unknown) => {
    render(width: number): string[];
    handleInput(data: string): void;
  })({
    source,
    getSettings: () => ({ tier: "ultra" }),
    mutate: async () => undefined,
    tui: { terminal: { rows: 50 }, requestRender: () => undefined },
    theme: identityTheme,
    border: (text: string) => text,
    done: () => undefined,
    notify: () => undefined,
  });

  component.render(170);
  component.handleInput("j");
  const detailAtTop = component.render(170).join("\n");
  assert.match(detailAtTop, /Итоговая инструкция Pohuy/);
  component.handleInput("J");
  const oppositePaneScrolled = component.render(170).join("\n");
  assert.doesNotMatch(oppositePaneScrolled, /Итоговая инструкция Pohuy/);
  component.handleInput("K");
  assert.match(component.render(170).join("\n"), /Итоговая инструкция Pohuy/);

  component.handleInput("f");
  const listFocus = component.render(170).join("\n");
  assert.doesNotMatch(listFocus, /РЕЗУЛЬТАТЫ ПОИСКА\s+│\s+ЭЛЕМЕНТ/);
  assert.doesNotMatch(listFocus, /Итоговая инструкция Pohuy/);
  component.handleInput("f");
  component.handleInput("\t");
  component.handleInput("f");
  let detailFocusLines = component.render(170);
  let detailFocus = detailFocusLines.join("\n");
  assert.match(detailFocus, /ПОДРОБНОСТИ/);
  assert.match(detailFocus, /Итоговая инструкция Pohuy/);
  assert.match(detailFocusLines.at(-2) ?? "", /↑↓ прокрутка/);
  assert.doesNotMatch(detailFocus, /(?:j k|jk|PgUp|PgDn)/);
  assert.equal(detailFocus.match(/\? помощь/g)?.length, 1);
  for (let index = 0; index < 14; index += 1) component.handleInput("j");
  detailFocusLines = component.render(170);
  detailFocus = detailFocusLines.join("\n");
  assert.match(detailFocus, /Мат идиоматический.*сказал бы живой человек/);
  component.handleInput("f");

  component.handleInput("4");
  assert.match(component.render(170)[1], /Общие Skill Словарь \[Сцены\]/);
  component.handleInput("2");
  assert.match(component.render(170)[1], /Общие \[Skill\] Словарь Сцены/);

  component.handleInput("?");
  const help = component.render(170).join("\n");
  assert.match(help, /Pohuy: клавиши/);
  assert.match(help, /Shift\+J\/K/);
  assert.match(help, /развернуть активную панель/);
  assert.match(help, /1 2 3 4/);
  component.handleInput("\x03");
  assert.doesNotMatch(component.render(170).join("\n"), /Pohuy: клавиши/);
  component.handleInput("?");
  component.handleInput("?");
  assert.doesNotMatch(component.render(170).join("\n"), /Pohuy: клавиши/);

  const compactFooter = component.render(69).slice(-3).join("\n");
  assert.match(compactFooter, /\? помощь/);
});

test("Space toggles a nested dictionary group while the detail panel is focused", async () => {
  initTheme("dark");
  const source = await loadStyleSource();
  const identityTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  let settings = { tier: "full" as const };
  let appliedPatch: { itemOverrides?: Record<string, boolean> } | undefined;
  const component = (createStyleSettingsComponent as (options: unknown) => {
    render(width: number): string[];
    handleInput(data: string): void;
  })({
    source,
    getSettings: () => settings,
    mutate: async (patch: { itemOverrides?: Record<string, boolean> }) => {
      appliedPatch = patch;
      settings = { ...settings, ...patch } as typeof settings;
    },
    tui: { terminal: { rows: 50 }, requestRender: () => undefined },
    theme: identityTheme,
    border: (text: string) => text,
    done: () => undefined,
    notify: () => undefined,
  });

  component.handleInput("/");
  for (const character of "Лексика отношения к агентам") component.handleInput(character);
  component.handleInput("\r");
  component.handleInput("\t");
  assert.match(component.render(170).at(-2) ?? "", /Space переключить группу/);
  component.handleInput(" ");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(appliedPatch?.itemOverrides);
  assert.ok(Object.keys(appliedPatch.itemOverrides).length > 0);
  assert.ok(Object.values(appliedPatch.itemOverrides).every(Boolean));

  component.handleInput("\t");
  component.handleInput("/");
  for (const character of "пиздарики") component.handleInput(character);
  component.handleInput("\r");
  const entryCard = component.render(170).join("\n");
  assert.doesNotMatch(entryCard, /СОСЕДНИЕ ЗАПИСИ/);
  assert.doesNotMatch(entryCard, /\*\*/);
  assert.equal(entryCard.match(/лёгкая констатация наступившего провала/g)?.length, 1);
  assert.match(component.render(170).at(-2) ?? "", /←\/h к родителю/);

  const narrowList = component.render(69);
  assert.ok(narrowList.every((line) => visibleWidth(line) === 69));
  assert.match(narrowList.at(-2) ?? "", /↑↓ выбор.*Tab\/Enter карточка.*\? помощь/);
  component.handleInput("\t");
  let narrowCard = component.render(69);
  assert.match(narrowCard.join("\n"), /СОСЕДНИЕ ЗАПИСИ/);
  assert.match(narrowCard.at(-2) ?? "", /Tab\/Backspace\/Esc к дереву/);
  component.handleInput("\t");
  assert.match(component.render(69).join("\n"), /ВЫБРАНО\s+пиздарики/);
  component.handleInput("\r");
  narrowCard = component.render(69);
  assert.match(narrowCard.join("\n"), /СОСЕДНИЕ ЗАПИСИ/);
  component.handleInput("\x1b");
  assert.match(component.render(69).join("\n"), /ВЫБРАНО\s+пиздарики/);

  component.handleInput("h");
  const parentSelected = component.render(170);
  const parentList = parentSelected.slice(5, -3).map((line) => line.split("│")[1] ?? "").join("\n");
  assert.match(parentList, /→ .*Состояния и статусы/);
  assert.match(parentSelected.at(-2) ?? "", /←\/h свернуть/);
  component.handleInput("h");
  const collapsed = component.render(170);
  const collapsedList = collapsed.slice(5, -3).map((line) => line.split("│")[1] ?? "").join("\n");
  assert.doesNotMatch(collapsedList, /пиздарики/);
  const collapsedText = collapsed.join("\n");
  assert.match(collapsedText, /ВКЛЮЧЕНО\s+\d+ из \d+/);
  assert.match(collapsedText, /ТЕКСТ РАЗДЕЛА/);
  assert.match(collapsedText, /Кластер ебашит/);
  assert.doesNotMatch(collapsedText, /ВНУТРИ \(только просмотр\)/);
  assert.ok(collapsedText.indexOf("ВКЛЮЧЕНО") < collapsedText.indexOf("ТЕКСТ РАЗДЕЛА"));
  assert.match(collapsed.at(-2) ?? "", /→\/l раскрыть/);

  const stateGroup = source.roots.dictionary.find((node) => node.label === "Состояния и статусы");
  assert.ok(stateGroup?.children[0]);
  component.handleInput("l");
  component.handleInput("l");
  const firstChildSelected = component.render(170);
  const firstChildLines = firstChildSelected.slice(5, -3).map((line) => line.split("│")[1] ?? "");
  const firstChildLine = firstChildLines.find((line) => line.includes(stateGroup.children[0].label));
  assert.ok(firstChildLine?.includes("→"));

  component.handleInput("]");
  component.handleInput("/");
  for (const character of "10. Катастрофа") component.handleInput(character);
  component.handleInput("\r");
  const sceneFrame = component.render(170);
  const sceneDetail = sceneFrame.slice(5, -3).map((line) => line.split("│")[2] ?? "").join("\n");
  assert.match(sceneDetail, /УРОВЕНЬ\s+10 из 10/);
  assert.match(sceneDetail, /ЛЕКСИКА\s+полный пиздец/);
  assert.match(sceneDetail, /СОВПАДЕНИЯ СО СЛОВАРЁМ/);
  assert.match(sceneDetail, /Состояния и статусы\s+1 запись/);
  assert.match(sceneDetail, /Образность: восклицания, звукопись, присказки\s+3 записи/);
  assert.match(sceneDetail, /ПРИМЕРЫ ОТВЕТОВ/);
  assert.doesNotMatch(sceneDetail, /### 10\.|ЧТО ДЕЛАЕТ|ШКАЛА|УСЛОВИЕ|1 совпадений/);
  assert.equal(sceneDetail.match(/полный пиздец, высший пиздец, накрылось пиздой/g)?.length, 1);
  const narrowSceneFrame = component.render(130).join("\n");
  assert.match(narrowSceneFrame, /Идея пользователя так себе.*…/);
});

test("active tab and search control use the same frame color", async () => {
  initTheme("dark");
  const source = await loadStyleSource();
  const accent = (text: string) => `\x1b[35m${text}\x1b[39m`;
  const component = (createStyleSettingsComponent as (options: unknown) => { render(width: number): string[] })({
    source,
    getSettings: () => ({ tier: "full" }),
    mutate: async () => undefined,
    tui: { terminal: { rows: 50 }, requestRender: () => undefined },
    theme: {
      fg: (color: string, text: string) => color === "accent" ? accent(text) : text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
    border: (text: string) => text,
    done: () => undefined,
    notify: () => undefined,
  });
  const header = component.render(170)[1];
  assert.match(header, /\x1b\[35m\[Общие\]\x1b\[39m/);
  assert.match(header, /\x1b\[35m\[\x1b\[39m.*\x1b\[35m\]\x1b\[39m/);
});

test("repeated prompt injection is idempotent", () => {
  const first = placeStylePromptAtAppendBoundary("Base\n\nAppend", "Append", "policy");
  const second = placeStylePromptAtAppendBoundary(first, "Append", "policy");

  assert.equal(second, first);
  assert.equal(markerCount(second), 1);
});
