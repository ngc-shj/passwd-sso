"use client";

interface RouterBackLike {
  back: () => void;
}

export function createFormNavigationHandlers({
  onSaved,
  router,
}: {
  onSaved?: () => void;
  router: RouterBackLike;
}) {
  const handleCancel = () => {
    if (onSaved) {
      onSaved();
      return;
    }
    router.back();
  };

  const handleBack = () => {
    router.back();
  };

  return { handleCancel, handleBack };
}
