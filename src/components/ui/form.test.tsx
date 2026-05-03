// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { useEffect } from "react";
import type { ReactNode } from "react";

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "./form";
import { Input } from "./input";

type Values = { email: string };

function Harness({
  defaultValues = { email: "" },
  errorMessage,
  children,
}: {
  defaultValues?: Values;
  errorMessage?: string;
  children: (props: { isError: boolean }) => ReactNode;
}) {
  const methods = useForm<Values>({ defaultValues });
  // Set the error after mount via effect so we don't trigger a setState during
  // render (which produces a React warning).
  useEffect(() => {
    if (errorMessage) {
      methods.setError("email", { type: "manual", message: errorMessage });
    }
  }, [errorMessage, methods]);
  return <Form {...methods}>{children({ isError: !!errorMessage })}</Form>;
}

describe("Form", () => {
  it("associates label with input via htmlFor and aria-describedby", () => {
    render(
      <Harness>
        {() => (
          <FormField
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormDescription>We will not share it.</FormDescription>
              </FormItem>
            )}
          />
        )}
      </Harness>,
    );

    const input = screen.getByLabelText("Email");
    expect(input).toBeInTheDocument();
    // The control receives an aria-describedby that includes the description id.
    expect(input).toHaveAttribute("aria-describedby");
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  it("renders FormMessage with the field error message and aria-invalid=true", async () => {
    render(
      <Harness errorMessage="Required">
        {() => (
          <FormField
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
      </Harness>,
    );

    expect(await screen.findByText("Required")).toHaveAttribute(
      "data-slot",
      "form-message",
    );
    expect(screen.getByLabelText("Email")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("renders FormMessage children when no error is set", () => {
    render(
      <Harness>
        {() => (
          <FormField
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage>Hint text</FormMessage>
              </FormItem>
            )}
          />
        )}
      </Harness>,
    );

    expect(screen.getByText("Hint text")).toBeInTheDocument();
  });
});
