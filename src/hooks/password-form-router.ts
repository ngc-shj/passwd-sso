"use client";

export interface PasswordFormRouter {
  push: (href: string) => void;
  refresh: () => void;
  back: () => void;
}

export type PasswordSubmitRouter = Pick<PasswordFormRouter, "push" | "refresh">;
