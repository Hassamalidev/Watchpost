/*
 * Zod validation at the HTTP edge (PRODUCT.md §7.1 rule 7, §7.9 step 8). Parsed values replace the
 * raw ones on res.locals.input, so controllers read typed data and never touch req.body directly.
 */
import type { Request, RequestHandler, Response } from "express";
import type { z } from "zod";
import { ValidationError, type FieldError } from "../core/errors.js";
import "./context.js";

export interface ValidationSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

export type ValidatedInput<S extends ValidationSchemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.infer<S[K]> : never;
};

function toFieldErrors(part: string, error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: [part, ...issue.path.map(String)].join("."),
    message: issue.message,
  }));
}

export function validate<S extends ValidationSchemas>(schemas: S): RequestHandler {
  return (req, res, next) => {
    const input: Record<string, unknown> = {};
    const errors: FieldError[] = [];
    for (const part of ["params", "query", "body"] as const) {
      const schema = schemas[part];
      if (schema === undefined) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) input[part] = result.data;
      else errors.push(...toFieldErrors(part, result.error));
    }
    if (errors.length > 0) {
      next(new ValidationError("The request is invalid.", errors));
      return;
    }
    res.locals.input = input;
    next();
  };
}

/* For handlers behind validate(schemas). */
export function inputOf<S extends ValidationSchemas>(
  _req: Request,
  res: Response,
): ValidatedInput<S> {
  return (res.locals.input ?? {}) as ValidatedInput<S>;
}
