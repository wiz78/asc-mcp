import { z } from "zod";
import { PublicError } from "./asc-errors.mjs";

export function schemaCompiler(definitions) {
  const references = new Map();
  function compile(schema = {}) {
    if (schema.$ref) {
      const name = schema.$ref.replace("#/components/schemas/", "");
      if (!Object.hasOwn(definitions, name)) throw new PublicError("Unknown API schema reference.");
      if (!references.has(name)) references.set(name, z.lazy(() => compile(definitions[name])));
      const result = references.get(name);
      return schema.nullable ? result.nullable() : result;
    }
    if (schema.allOf) {
      const parts = schema.allOf.map(part => part.$ref ? definitions[part.$ref.replace("#/components/schemas/", "")] : part);
      if (parts.every(part => part.type === "object" || part.properties)) {
        return compile({
          type: "object",
          properties: Object.assign({}, ...parts.map(part => part.properties)),
          required: [...new Set(parts.flatMap(part => part.required || []))]
        });
      }
      return parts.map(compile).reduce((a, b) => z.intersection(a, b));
    }
    const choices = schema.oneOf || schema.anyOf;
    let result;
    if (choices?.length) result = choices.length === 1 ? compile(choices[0]) : z.union(choices.map(compile));
    else if (schema.enum?.length) {
      const values = schema.enum.map(value => z.literal(value));
      result = values.length === 1 ? values[0] : z.union(values);
    } else if (schema.type === "object" || schema.properties) {
      const shape = {};
      for (const [name, definition] of Object.entries(schema.properties || {})) {
        const property = compile(definition);
        shape[name] = schema.required?.includes(name) ? property : property.optional();
      }
      result = z.strictObject(shape);
      if (schema.additionalProperties === true) result = result.catchall(z.json());
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") result = result.catchall(compile(schema.additionalProperties));
    } else if (schema.type === "array") {
      result = z.array(compile(schema.items)).max(Math.min(schema.maxItems ?? 1000, 1000));
      if (schema.minItems) result = result.min(schema.minItems);
    } else if (schema.type === "integer" || schema.type === "number") {
      result = z.number();
      if (schema.type === "integer") result = result.int().safe();
      if (schema.minimum !== undefined) result = result.min(schema.minimum);
      if (schema.maximum !== undefined) result = result.max(schema.maximum);
    } else if (schema.type === "boolean") result = z.boolean();
    else if (schema.type === "string") {
      result = z.string().max(Math.min(schema.maxLength ?? 262144, 262144));
      if (schema.minLength) result = result.min(schema.minLength);
      if (schema.pattern) result = result.regex(new RegExp(schema.pattern));
    } else result = z.json();
    return schema.nullable ? result.nullable() : result;
  }
  return compile;
}

export function operationSchema(operation, compile) {
  const shape = {};
  for (const location of ["path", "query"]) {
    const parameters = operation.parameters.filter(parameter => parameter.in === location);
    if (!parameters.length) continue;
    const values = {};
    for (const parameter of parameters) {
      let schema = compile(parameter.schema);
      if (location === "path") schema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
      values[parameter.name] = parameter.required ? schema : schema.optional();
    }
    const object = z.strictObject(values);
    shape[location] = parameters.some(parameter => parameter.required) ? object : object.optional();
  }
  if (operation.requestBody) {
    const body = compile(operation.requestBody);
    shape.body = operation.requestBodyRequired ? body : body.optional();
  }
  return z.strictObject(shape);
}
