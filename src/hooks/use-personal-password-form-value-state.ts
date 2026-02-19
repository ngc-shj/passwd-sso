import { useState } from "react";
import type { TagData } from "@/components/tags/tag-input";
import { type GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { PersonalPasswordFormInitialValues } from "@/hooks/use-personal-password-form-state";

export function usePersonalPasswordFormValueState(initial: PersonalPasswordFormInitialValues) {
  const [title, setTitle] = useState(initial.title);
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState(initial.password);
  const [url, setUrl] = useState(initial.url);
  const [notes, setNotes] = useState(initial.notes);
  const [selectedTags, setSelectedTags] = useState<TagData[]>(initial.selectedTags);
  const [generatorSettings, setGeneratorSettings] = useState<GeneratorSettings>(initial.generatorSettings);
  const [customFields, setCustomFields] = useState<EntryCustomField[]>(initial.customFields);
  const [totp, setTotp] = useState<EntryTotp | null>(initial.totp);
  const [showTotpInput, setShowTotpInput] = useState(initial.showTotpInput);
  const [requireReprompt, setRequireReprompt] = useState(initial.requireReprompt);
  const [folderId, setFolderId] = useState<string | null>(initial.folderId);

  return {
    values: {
      title,
      username,
      password,
      url,
      notes,
      selectedTags,
      generatorSettings,
      customFields,
      totp,
      showTotpInput,
      requireReprompt,
      folderId,
    },
    setters: {
      setTitle,
      setUsername,
      setPassword,
      setUrl,
      setNotes,
      setSelectedTags,
      setGeneratorSettings,
      setCustomFields,
      setTotp,
      setShowTotpInput,
      setRequireReprompt,
      setFolderId,
    },
  };
}
