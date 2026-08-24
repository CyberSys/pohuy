import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isJsonObject,
  isTier,
  type JsonObject,
  type SettingsPatch,
  type StoredSettings,
} from "./style-source.js";

const SETTINGS_KEY = "pohuy";
export const SETTINGS_PATH = join(getAgentDir(), "settings.json");

export async function readStoredSettings(): Promise<StoredSettings> {
  try {
    const root: unknown = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    if (!isJsonObject(root) || !isJsonObject(root[SETTINGS_KEY])) {
      return { tier: "normal" };
    }

    const record = root[SETTINGS_KEY];
    const rawTier = record.tier;
    const tier = rawTier === "normal" || isTier(rawTier) ? rawTier : "normal";
    const skillEnabled = typeof record.skillEnabled === "boolean" ? record.skillEnabled : undefined;
    const selectedSections = Array.isArray(record.selectedSections)
      ? [...new Set(record.selectedSections.filter((value): value is string => typeof value === "string"))]
      : undefined;
    const itemOverrides = isJsonObject(record.itemOverrides)
      ? Object.fromEntries(Object.entries(record.itemOverrides).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
      : undefined;
    return {
      tier,
      ...(skillEnabled === undefined ? {} : { skillEnabled }),
      ...(selectedSections === undefined ? {} : { selectedSections }),
      ...(itemOverrides === undefined ? {} : { itemOverrides }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return { tier: "normal" };
    }
    throw error;
  }
}

export function applySettingsPatch(settings: StoredSettings, patch: SettingsPatch): StoredSettings {
  const next: StoredSettings = {
    ...settings,
    tier: patch.tier ?? settings.tier,
    skillEnabled: patch.skillEnabled ?? settings.skillEnabled,
  };
  if (patch.selectedSections === null) {
    delete next.selectedSections;
  } else if (patch.selectedSections !== undefined) {
    next.selectedSections = [...new Set(patch.selectedSections)];
  }
  if (patch.itemOverrides === null) {
    delete next.itemOverrides;
  } else if (patch.itemOverrides !== undefined) {
    next.itemOverrides = { ...patch.itemOverrides };
  }
  return next;
}

export function fitSettingsRender(lines: string[], width: number, height: number): string[] {
  const safeWidth = Math.max(0, width);
  const safeHeight = Math.max(0, height);
  return lines
    .slice(0, safeHeight)
    .map((line) => truncateToWidth(line, safeWidth, ""));
}

export function mergeStoredSettings(root: JsonObject, patch: SettingsPatch): JsonObject {
  const current = isJsonObject(root[SETTINGS_KEY]) ? { ...root[SETTINGS_KEY] } : {};
  if (patch.tier !== undefined) current.tier = patch.tier;
  if (patch.skillEnabled !== undefined) current.skillEnabled = patch.skillEnabled;
  if (patch.selectedSections === null) {
    delete current.selectedSections;
  } else if (patch.selectedSections !== undefined) {
    current.selectedSections = [...new Set(patch.selectedSections)];
  }
  if (patch.itemOverrides === null) {
    delete current.itemOverrides;
  } else if (patch.itemOverrides !== undefined) {
    current.itemOverrides = { ...patch.itemOverrides };
  }
  return { ...root, [SETTINGS_KEY]: current };
}

export function diffStoredSettings(current: StoredSettings, next: StoredSettings): SettingsPatch {
  return {
    ...(current.tier === next.tier ? {} : { tier: next.tier }),
    ...((current.skillEnabled ?? true) === (next.skillEnabled ?? true)
      ? {}
      : { skillEnabled: next.skillEnabled ?? true }),
    ...(JSON.stringify(current.selectedSections) === JSON.stringify(next.selectedSections)
      ? {}
      : { selectedSections: next.selectedSections ?? null }),
    ...(JSON.stringify(current.itemOverrides ?? {}) === JSON.stringify(next.itemOverrides ?? {})
      ? {}
      : { itemOverrides: next.itemOverrides ?? null }),
  };
}

export async function saveStoredSettings(patch: SettingsPatch): Promise<void> {
  await withFileMutationQueue(SETTINGS_PATH, async () => {
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });

    let root: JsonObject = {};
    let mode = 0o600;
    try {
      mode = (await stat(SETTINGS_PATH)).mode & 0o777;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const backup = `${SETTINGS_PATH}.corrupt-${Date.now()}-${randomUUID()}`;
        await rename(SETTINGS_PATH, backup);
      }
      if (parsed !== undefined) {
        if (isJsonObject(parsed)) {
          root = parsed;
        } else {
          const backup = `${SETTINGS_PATH}.corrupt-${Date.now()}-${randomUUID()}`;
          await rename(SETTINGS_PATH, backup);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const nextRoot = mergeStoredSettings(root, patch);
    const temporary = `${SETTINGS_PATH}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", mode);
      try {
        await handle.writeFile(`${JSON.stringify(nextRoot, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, SETTINGS_PATH);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}


