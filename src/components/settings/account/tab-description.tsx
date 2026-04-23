export function TabDescription({ children }: { children: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
