import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildStylePolicy,
  fitSettingsRender,
  loadStyleSource,
  mergeStoredSettings,
  placeStylePromptAtAppendBoundary,
  stripManagedStyleBlocks,
} from "./pohuy.js";

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

test("leaves unmatched project text intact", () => {
  const base = `Base\n\n${START}\nunterminated project text`;

  assert.equal(stripManagedStyleBlocks(base), base);
});

test("preserves malformed marker text before a later completed block", () => {
  const base = [
    "Base",
    `${START}\nunterminated project text`,
    `${START}\nmanaged policy\n${END}`,
    "Append",
  ].join("\n\n");

  assert.equal(
    stripManagedStyleBlocks(base),
    ["Base", `${START}\nunterminated project text`, "Append"].join("\n\n"),
  );
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
  assert.match(policy, /### Триумф после долгого дебага/);
  assert.match(policy, /таймзона в CI/);
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

test("repeated prompt injection is idempotent", () => {
  const first = placeStylePromptAtAppendBoundary("Base\n\nAppend", "Append", "policy");
  const second = placeStylePromptAtAppendBoundary(first, "Append", "policy");

  assert.equal(second, first);
  assert.equal(markerCount(second), 1);
});
