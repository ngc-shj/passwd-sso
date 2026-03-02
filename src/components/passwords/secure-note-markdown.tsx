"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

interface SecureNoteMarkdownProps {
  content: string;
  className?: string;
}

const SAFE_PROTOCOLS = ["http:", "https:", "mailto:"];

const components: Components = {
  a: ({ href, children, ...props }) => {
    // Block javascript: and other dangerous protocol URLs
    let safeSrc = href ?? "";
    try {
      const url = new URL(safeSrc, "https://placeholder.invalid");
      if (!SAFE_PROTOCOLS.includes(url.protocol)) {
        safeSrc = "";
      }
    } catch {
      safeSrc = "";
    }
    return (
      <a
        href={safeSrc || undefined}
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      >
        {children}
      </a>
    );
  },
  img: ({ alt }) => {
    // Block external image loading to prevent IP tracking via image URLs
    return <span className="text-muted-foreground">[Image: {alt ?? ""}]</span>;
  },
};

export function SecureNoteMarkdown({
  content,
  className = "",
}: SecureNoteMarkdownProps) {
  return (
    <div
      className={`prose prose-sm dark:prose-invert max-w-none break-words ${className}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
