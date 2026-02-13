"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RefreshCw, History, Copy, Check } from "lucide-react";
import {
  SYMBOL_GROUPS,
  SYMBOL_GROUP_KEYS,
  type SymbolGroupKey,
  type GeneratorSettings,
  type GeneratorMode,
  type PassphraseSettings,
  DEFAULT_GENERATOR_SETTINGS,
  buildSymbolString,
} from "@/lib/generator-prefs";
import { API_PATH } from "@/lib/constants";

interface PasswordGeneratorProps {
  open: boolean;
  onClose: () => void;
  onUse: (password: string, settings: GeneratorSettings) => void;
  settings?: GeneratorSettings;
}

const SEPARATORS = ["-", ".", "_", " "];

export function PasswordGenerator({
  open,
  onClose,
  onUse,
  settings: initialSettings,
}: PasswordGeneratorProps) {
  const t = useTranslations("PasswordGenerator");
  const tc = useTranslations("Common");
  const [settings, setSettings] = useState<GeneratorSettings>(
    initialSettings ?? { ...DEFAULT_GENERATOR_SETTINGS }
  );
  const [generated, setGenerated] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Sync when initialSettings changes (e.g. editing a different entry)
  useEffect(() => {
    if (initialSettings) {
      setSettings(initialSettings);
    }
  }, [initialSettings]);

  const generate = useCallback(async () => {
    if (settings.mode === "passphrase") {
      const res = await fetch(API_PATH.PASSWORDS_GENERATE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "passphrase",
          ...settings.passphrase,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setGenerated(data.password);
      }
    } else {
      const symbols = buildSymbolString(settings.symbolGroups);
      const res = await fetch(API_PATH.PASSWORDS_GENERATE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "password",
          length: settings.length,
          uppercase: settings.uppercase,
          lowercase: settings.lowercase,
          numbers: settings.numbers,
          symbols,
          excludeAmbiguous: settings.excludeAmbiguous,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setGenerated(data.password);
      }
    }
  }, [settings]);

  // Auto-generate when opened or settings change
  useEffect(() => {
    if (open) generate();
  }, [open, generate]);

  if (!open) return null;

  const handleUse = () => {
    if (generated) {
      setHistory((prev) => [generated, ...prev].slice(0, 10));
      onUse(generated, settings);
      onClose();
    }
  };

  const copyHistory = async (pw: string, idx: number) => {
    await navigator.clipboard.writeText(pw);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  const update = (partial: Partial<GeneratorSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  };

  const updatePassphrase = (partial: Partial<PassphraseSettings>) => {
    setSettings((prev) => ({
      ...prev,
      passphrase: { ...prev.passphrase, ...partial },
    }));
  };

  const toggleSymbolGroup = (key: SymbolGroupKey) => {
    setSettings((prev) => ({
      ...prev,
      symbolGroups: {
        ...prev.symbolGroups,
        [key]: !prev.symbolGroups[key],
      },
    }));
  };

  const anySymbolEnabled = SYMBOL_GROUP_KEYS.some(
    (key) => settings.symbolGroups[key]
  );
  const anyTypeEnabled =
    settings.mode === "passphrase" ||
    settings.uppercase ||
    settings.lowercase ||
    settings.numbers ||
    anySymbolEnabled;

  const setMode = (mode: GeneratorMode) => update({ mode });

  return (
    <div className="rounded-lg border bg-popover shadow-md p-3 space-y-3">
      {/* Top bar: Cancel | Refresh | Use */}
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onClose}
        >
          {tc("cancel")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={generate}
          disabled={!anyTypeEnabled}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={handleUse}
          disabled={!generated}
        >
          {t("use")}
        </Button>
      </div>

      {/* Mode toggle */}
      <div className="flex rounded-md border overflow-hidden">
        <button
          type="button"
          className={`flex-1 text-xs py-1.5 transition-colors ${
            settings.mode === "password"
              ? "bg-primary text-primary-foreground"
              : "bg-muted/50 text-muted-foreground hover:bg-muted"
          }`}
          onClick={() => setMode("password")}
        >
          {t("modePassword")}
        </button>
        <button
          type="button"
          className={`flex-1 text-xs py-1.5 transition-colors ${
            settings.mode === "passphrase"
              ? "bg-primary text-primary-foreground"
              : "bg-muted/50 text-muted-foreground hover:bg-muted"
          }`}
          onClick={() => setMode("passphrase")}
        >
          {t("modePassphrase")}
        </button>
      </div>

      {/* Generated password display */}
      {generated && (
        <div className="rounded-md bg-muted px-3 py-2">
          <p className="font-mono text-sm break-all leading-relaxed">
            {generated}
          </p>
        </div>
      )}

      {/* Settings */}
      <div className="space-y-2.5">
        {settings.mode === "password" ? (
          <>
            {/* Length: label + slider + input in one row */}
            <div className="flex items-center gap-2">
              <Label htmlFor="gen-length" className="text-xs text-muted-foreground shrink-0">
                {t("length")}
              </Label>
              <Slider
                value={[settings.length]}
                onValueChange={([v]) => update({ length: v })}
                min={8}
                max={128}
                step={1}
                className="flex-1"
              />
              <Input
                id="gen-length"
                type="number"
                min={8}
                max={128}
                value={settings.length}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v)) update({ length: v });
                }}
                onBlur={() => {
                  update({ length: Math.min(128, Math.max(8, settings.length)) });
                }}
                className="h-7 w-18 text-xs text-center shrink-0"
              />
            </div>

            {/* Character types */}
            <div className="pt-1 border-t space-y-2">
              <Label className="text-xs text-muted-foreground font-medium">
                {t("charTypes")}
              </Label>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="gen-uppercase"
                  checked={settings.uppercase}
                  onCheckedChange={(v) => update({ uppercase: !!v })}
                />
                <Label
                  htmlFor="gen-uppercase"
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  {t("uppercase")}
                </Label>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="gen-lowercase"
                  checked={settings.lowercase}
                  onCheckedChange={(v) => update({ lowercase: !!v })}
                />
                <Label
                  htmlFor="gen-lowercase"
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  {t("lowercase")}
                </Label>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="gen-numbers"
                  checked={settings.numbers}
                  onCheckedChange={(v) => update({ numbers: !!v })}
                />
                <Label
                  htmlFor="gen-numbers"
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  {t("numbers")}
                </Label>
              </div>

              {SYMBOL_GROUP_KEYS.map((key) => (
                <div key={key} className="flex items-center gap-2">
                  <Checkbox
                    id={`gen-sym-${key}`}
                    checked={settings.symbolGroups[key]}
                    onCheckedChange={() => toggleSymbolGroup(key)}
                  />
                  <Label
                    htmlFor={`gen-sym-${key}`}
                    className="text-xs font-mono text-muted-foreground cursor-pointer"
                  >
                    {SYMBOL_GROUPS[key]}
                  </Label>
                </div>
              ))}

              <div className="flex items-center gap-2 pt-1 border-t">
                <Checkbox
                  id="gen-exclude-ambiguous"
                  checked={settings.excludeAmbiguous}
                  onCheckedChange={(v) => update({ excludeAmbiguous: !!v })}
                />
                <Label
                  htmlFor="gen-exclude-ambiguous"
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  {t("excludeAmbiguous")}
                </Label>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Passphrase settings */}
            <div className="flex items-center gap-2">
              <Label htmlFor="gen-words" className="text-xs text-muted-foreground shrink-0">
                {t("wordCount")}
              </Label>
              <Slider
                value={[settings.passphrase.wordCount]}
                onValueChange={([v]) => updatePassphrase({ wordCount: v })}
                min={3}
                max={10}
                step={1}
                className="flex-1"
              />
              <Input
                id="gen-words"
                type="number"
                min={3}
                max={10}
                value={settings.passphrase.wordCount}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v)) updatePassphrase({ wordCount: v });
                }}
                onBlur={() => {
                  updatePassphrase({
                    wordCount: Math.min(10, Math.max(3, settings.passphrase.wordCount)),
                  });
                }}
                className="h-7 w-18 text-xs text-center shrink-0"
              />
            </div>

            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground shrink-0">
                {t("separator")}
              </Label>
              <div className="flex gap-1">
                {SEPARATORS.map((sep) => (
                  <Button
                    key={sep}
                    type="button"
                    variant={settings.passphrase.separator === sep ? "default" : "outline"}
                    size="sm"
                    className="h-7 w-7 text-xs font-mono p-0"
                    onClick={() => updatePassphrase({ separator: sep })}
                  >
                    {sep === " " ? "\u2423" : sep}
                  </Button>
                ))}
              </div>
            </div>

            <div className="pt-1 border-t space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="gen-capitalize"
                  checked={settings.passphrase.capitalize}
                  onCheckedChange={(v) => updatePassphrase({ capitalize: !!v })}
                />
                <Label
                  htmlFor="gen-capitalize"
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  {t("capitalize")}
                </Label>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="gen-include-number"
                  checked={settings.passphrase.includeNumber}
                  onCheckedChange={(v) => updatePassphrase({ includeNumber: !!v })}
                />
                <Label
                  htmlFor="gen-include-number"
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  {t("includeNumber")}
                </Label>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Generation history */}
      {history.length > 0 && (
        <div className="border-t pt-2">
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
            onClick={() => setShowHistory((v) => !v)}
          >
            <History className="h-3 w-3" />
            {t("history")} ({history.length})
          </button>
          {showHistory && (
            <div className="mt-1.5 space-y-1 max-h-32 overflow-auto">
              {history.map((pw, i) => (
                <div
                  key={`${i}-${pw}`}
                  className="flex items-center gap-1 group"
                >
                  <p className="font-mono text-xs text-muted-foreground truncate flex-1">
                    {pw}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    onClick={() => copyHistory(pw, i)}
                  >
                    {copiedIdx === i ? (
                      <Check className="h-3 w-3 text-green-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
