"use client";

interface RouterBackLike {
  back: () => void;
}

export function createFormNavigationHandlers({
  onCancel,
  router,
}: {
  onCancel?: () => void;
  router: RouterBackLike;
}) {
  const handleCancel = () => {
    if (onCancel) {
      onCancel();
      return;
    }
    router.back();
  };

  const handleBack = () => {
    router.back();
  };

  return { handleCancel, handleBack };
}
