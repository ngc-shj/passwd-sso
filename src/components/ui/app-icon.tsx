import type { SVGProps } from "react";

export function AppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" {...props}>
      <path
        fill="#5B57D6"
        d="M256 40L420 110L420 230C420 340 350 420 256 470C162 420 92 340 92 230L92 110Z"
      />
      <circle cx="256" cy="205" r="48" fill="white" />
      <path fill="white" d="M232 245L280 245L300 360L212 360Z" />
    </svg>
  );
}
