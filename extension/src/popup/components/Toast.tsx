interface ToastProps {
  message: string;
  type?: "success" | "error";
  visible: boolean;
}

export function Toast({ message, type = "success", visible }: ToastProps) {
  if (!visible) return null;
  const bg = type === "success" ? "bg-green-600" : "bg-red-600";
  return (
    <div className={`px-4 py-2 text-sm text-white text-center ${bg}`} role="status">
      {message}
    </div>
  );
}
