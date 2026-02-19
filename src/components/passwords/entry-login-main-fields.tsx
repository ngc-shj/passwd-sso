"use client";

import { Eye, EyeOff, Dices } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordGenerator } from "@/components/passwords/password-generator";
import type { GeneratorSettings } from "@/lib/generator-prefs";

interface EntryLoginMainFieldsProps {
  idPrefix?: string;
  hideTitle?: boolean;
  title: string;
  onTitleChange: (value: string) => void;
  titleLabel: string;
  titlePlaceholder: string;
  titleRequired?: boolean;
  username: string;
  onUsernameChange: (value: string) => void;
  usernameLabel: string;
  usernamePlaceholder: string;
  password: string;
  onPasswordChange: (value: string) => void;
  passwordLabel: string;
  passwordPlaceholder: string;
  passwordRequired?: boolean;
  showPassword: boolean;
  onToggleShowPassword: () => void;
  generatorSummary: string;
  showGenerator: boolean;
  onToggleGenerator: () => void;
  closeGeneratorLabel: string;
  openGeneratorLabel: string;
  generatorSettings: GeneratorSettings;
  onGeneratorUse: (password: string, settings: GeneratorSettings) => void;
  url: string;
  onUrlChange: (value: string) => void;
  urlLabel: string;
  notes: string;
  onNotesChange: (value: string) => void;
  notesLabel: string;
  notesPlaceholder: string;
}

export function EntryLoginMainFields({
  idPrefix = "",
  hideTitle = false,
  title,
  onTitleChange,
  titleLabel,
  titlePlaceholder,
  titleRequired = false,
  username,
  onUsernameChange,
  usernameLabel,
  usernamePlaceholder,
  password,
  onPasswordChange,
  passwordLabel,
  passwordPlaceholder,
  passwordRequired = false,
  showPassword,
  onToggleShowPassword,
  generatorSummary,
  showGenerator,
  onToggleGenerator,
  closeGeneratorLabel,
  openGeneratorLabel,
  generatorSettings,
  onGeneratorUse,
  url,
  onUrlChange,
  urlLabel,
  notes,
  onNotesChange,
  notesLabel,
  notesPlaceholder,
}: EntryLoginMainFieldsProps) {
  const titleId = `${idPrefix}title`;
  const usernameId = `${idPrefix}username`;
  const passwordId = `${idPrefix}password`;
  const urlId = `${idPrefix}url`;
  const notesId = `${idPrefix}notes`;

  return (
    <>
      {!hideTitle && (
        <div className="space-y-2">
          <Label htmlFor={titleId}>{titleLabel}</Label>
          <Input
            id={titleId}
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder={titlePlaceholder}
            required={titleRequired}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor={usernameId}>{usernameLabel}</Label>
        <Input
          id={usernameId}
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          placeholder={usernamePlaceholder}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2 rounded-lg border bg-background/70 p-3">
        <Label htmlFor={passwordId}>{passwordLabel}</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id={passwordId}
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder={passwordPlaceholder}
              required={passwordRequired}
              autoComplete="off"
            />
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onToggleShowPassword}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground">{generatorSummary}</p>
          <Button
            type="button"
            variant={showGenerator ? "secondary" : "outline"}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={onToggleGenerator}
          >
            <Dices className="h-3.5 w-3.5" />
            {showGenerator ? closeGeneratorLabel : openGeneratorLabel}
          </Button>
        </div>
        <PasswordGenerator
          open={showGenerator}
          onClose={onToggleGenerator}
          settings={generatorSettings}
          onUse={onGeneratorUse}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={urlId}>{urlLabel}</Label>
        <Input
          id={urlId}
          type="url"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="https://example.com"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={notesId}>{notesLabel}</Label>
        <textarea
          id={notesId}
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder={notesPlaceholder}
          rows={3}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
    </>
  );
}
