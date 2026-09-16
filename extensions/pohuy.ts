import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createStyleSettingsComponent } from "./pohuy/settings-ui.js";
import {
  applySettingsPatch,
  diffStoredSettings,
  readStoredSettings,
  saveStoredSettings,
} from "./pohuy/settings-store.js";
import {
  buildStylePrompt,
  isTier,
  loadStyleSource,
  normalizeStoredSettings,
  placeStylePromptAtAppendBoundary,
  sameStoredSettings,
  TIERS,
  type SettingsPatch,
  type StoredSettings,
  type StoredTier,
  type StyleSource,
} from "./pohuy/style-source.js";

export {
  buildStylePolicy,
  buildStylePrompt,
  buildStylePromptReport,
  loadStyleSource,
  normalizeStoredSettings,
  placeStylePromptAtAppendBoundary,
  selectTierVariant,
  stripManagedStyleBlocks,
} from "./pohuy/style-source.js";
export { diffStoredSettings, fitSettingsRender, mergeStoredSettings } from "./pohuy/settings-store.js";
export { createStyleSettingsComponent } from "./pohuy/settings-ui.js";

const USAGE = "Используйте /pohuy, /pohuy lite, /pohuy full, /pohuy ultra или /pohuy normal.";
const ENABLE_PHRASES = new Set(["та мне похуй", "заебал"]);
const DISABLE_PHRASES = new Set(["нормальный режим", "хватит материться"]);

export default async function pohuyExtension(pi: ExtensionAPI) {
  let styleSource: StyleSource | undefined;
  let settings: StoredSettings = { tier: "normal" };
  let settingsQueue: Promise<void> = Promise.resolve();

  const enqueueSettingsOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const queued = settingsQueue.then(operation);
    settingsQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };
  const enqueueSettingsMutation = (patch: SettingsPatch): Promise<StoredSettings> =>
    enqueueSettingsOperation(async () => {
      const loaded = await readStoredSettings();
      const current = styleSource ? normalizeStoredSettings(loaded, styleSource) : loaded;
      const next = styleSource
        ? normalizeStoredSettings(applySettingsPatch(current, patch), styleSource)
        : applySettingsPatch(current, patch);
      await saveStoredSettings(diffStoredSettings(loaded, next));
      settings = next;
      return settings;
    });
  const enqueueSettingsReload = (): Promise<StoredSettings> =>
    enqueueSettingsOperation(async () => {
      const loaded = await readStoredSettings();
      const next = styleSource ? normalizeStoredSettings(loaded, styleSource) : loaded;
      if (!sameStoredSettings(loaded, next)) await saveStoredSettings(diffStoredSettings(loaded, next));
      settings = next;
      return settings;
    });

  const [sourceResult, settingsResult] = await Promise.allSettled([
    loadStyleSource(),
    readStoredSettings(),
  ]);
  if (sourceResult.status === "fulfilled") styleSource = sourceResult.value;
  if (settingsResult.status === "fulfilled") {
    settings = styleSource
      ? normalizeStoredSettings(settingsResult.value, styleSource)
      : settingsResult.value;
  }

  pi.on("session_start", async (_event, ctx) => {
    const failures: string[] = [];
    if (!styleSource) {
      try {
        styleSource = await loadStyleSource();
      } catch (error) {
        failures.push(`источники: ${String(error)}`);
      }
    }
    try {
      await enqueueSettingsReload();
    } catch (error) {
      failures.push(`настройки: ${String(error)}`);
    }
    if (failures.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`Не удалось запустить Pohuy. ${failures.join(". ")}`, "error");
    }
  });

  pi.registerCommand("pohuy", {
    description: "Настроить стиль ответов, словарь и сцены Pohuy",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const options = [...TIERS, "normal"];
      const value = prefix.trim().toLowerCase();
      const items = options
        .filter((option) => option.startsWith(value))
        .map((option) => ({ value: option, label: option }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length > 1) {
        if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
        return;
      }

      if (tokens.length === 0) {
        try {
          styleSource ??= await loadStyleSource();
        } catch (error) {
          if (ctx.hasUI) ctx.ui.notify(`Не удалось загрузить источники Pohuy: ${String(error)}`, "error");
          return;
        }
        const source = styleSource;
        if (!ctx.hasUI || ctx.mode !== "tui") {
          if (ctx.hasUI) ctx.ui.notify("Меню настроек Pohuy доступно только в режиме TUI.", "warning");
          return;
        }

        await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
          createStyleSettingsComponent({
            source,
            getSettings: () => settings,
            mutate: async (patch) => { await enqueueSettingsMutation(patch); },
            tui,
            theme,
            border: theme.getThinkingBorderColor(ctx.thinkingLevel ?? "off"),
            done: () => done(undefined),
            notify: (message, level) => ctx.ui.notify(message, level),
          })
        );
        return;
      }

      const value = tokens[0];
      const tier: StoredTier | undefined = value === "normal" ? value : isTier(value) ? value : undefined;
      if (!tier) {
        if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
        return;
      }

      try {
        if (tier !== "normal") styleSource ??= await loadStyleSource();
        await enqueueSettingsMutation({ tier });
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Не удалось сохранить настройки Pohuy: ${String(error)}`, "error");
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.notify(
          tier === "normal" ? "Pohuy отключён. Включён обычный режим." : `Pohuy включён, режим: ${tier}.`,
          "info",
        );
      }
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const phrase = event.text.trim().toLowerCase().replace(/[.!?]+$/, "");
    const tier = ENABLE_PHRASES.has(phrase) ? "full" : DISABLE_PHRASES.has(phrase) ? "normal" : undefined;
    if (!tier) return { action: "continue" };

    try {
      if (tier !== "normal") styleSource ??= await loadStyleSource();
      await enqueueSettingsMutation({ tier });
      if (ctx.hasUI) {
        ctx.ui.notify(
          tier === "normal" ? "Pohuy отключён. Включён обычный режим." : "Pohuy включён, режим: full.",
          "info",
        );
      }
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Не удалось сохранить настройки Pohuy: ${String(error)}`, "error");
      return { action: "continue" };
    }

    return { action: "handled" };
  });

  pi.on("before_agent_start", (event) => {
    if (!styleSource) return;
    const stylePrompt = buildStylePrompt(settings, styleSource);

    const systemPrompt = placeStylePromptAtAppendBoundary(
      event.systemPrompt,
      event.systemPromptOptions.appendSystemPrompt,
      stylePrompt,
    );
    if (systemPrompt === event.systemPrompt) return;
    return { systemPrompt };
  });
}
