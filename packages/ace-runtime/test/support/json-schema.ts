/**
 * Minimal JSON Schema interpreter for tests.
 *
 * Supports exactly the keywords the ACE schemas use, so a schema document can be checked against
 * the hand-written validators that guard the same data.
 */

export interface JsonSchemaNode {
	type?: string;
	required?: string[];
	properties?: Record<string, JsonSchemaNode>;
	additionalProperties?: boolean | JsonSchemaNode;
	items?: JsonSchemaNode;
	const?: unknown;
	enum?: readonly unknown[];
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	minimum?: number;
	minItems?: number;
	minProperties?: number;
	propertyNames?: JsonSchemaNode;
	allOf?: JsonSchemaNode[];
	if?: JsonSchemaNode;
	then?: JsonSchemaNode;
	else?: JsonSchemaNode;
	not?: JsonSchemaNode;
	$ref?: string;
}

function resolveRef(root: JsonSchemaNode, reference: string): JsonSchemaNode {
	if (!reference.startsWith("#/")) throw new Error(`unsupported $ref: ${reference}`);
	let node: JsonSchemaNode | undefined = root;
	for (const segment of reference.slice(2).split("/")) {
		node = node ? (node as unknown as Record<string, JsonSchemaNode>)[segment] : undefined;
	}
	if (!node) throw new Error(`unresolvable $ref: ${reference}`);
	return node;
}

/** Whether `value` satisfies `schema`; errors describe the first failing keyword. */
export function schemaErrors(
	value: unknown,
	schema: JsonSchemaNode,
	root: JsonSchemaNode = schema,
	path = "",
): string[] {
	if (schema.$ref) return schemaErrors(value, resolveRef(root, schema.$ref), root, path);

	const errors: string[] = [];

	if (schema.if) {
		const branch = schemaErrors(value, schema.if, root, path).length === 0 ? schema.then : schema.else;
		if (branch) errors.push(...schemaErrors(value, branch, root, path));
	}

	for (const member of schema.allOf ?? []) {
		errors.push(...schemaErrors(value, member, root, path));
	}

	if (schema.not && schemaErrors(value, schema.not, root, path).length === 0) {
		errors.push(`${path}: must not match the "not" subschema`);
	}

	if (schema.const !== undefined && value !== schema.const)
		errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
	if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join("|")}`);

	// `required`/`properties` are independent keywords: they apply to objects even when `type` is
	// absent, and are vacuously satisfied for non-objects.
	if (schema.type === "object" || schema.required !== undefined || schema.properties !== undefined) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			if (schema.type === "object") errors.push(`${path}: must be an object`);
		} else {
			const record = value as Record<string, unknown>;
			if (schema.minProperties !== undefined && Object.keys(record).length < schema.minProperties) {
				errors.push(`${path}: needs at least ${schema.minProperties} properties`);
			}
			for (const key of Object.keys(record)) {
				if (schema.propertyNames) errors.push(...schemaErrors(key, schema.propertyNames, root, `${path}${key}: `));
			}
			for (const key of schema.required ?? []) {
				if (!(key in record)) errors.push(`${path}${key}: is required`);
			}
			for (const [key, child] of Object.entries(schema.properties ?? {})) {
				if (key in record) errors.push(...schemaErrors(record[key], child, root, `${path}${key}.`));
			}
			const known = new Set(Object.keys(schema.properties ?? {}));
			for (const key of Object.keys(record)) {
				if (known.has(key)) continue;
				if (schema.additionalProperties === false) errors.push(`${path}${key}: is not allowed`);
				else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
					errors.push(...schemaErrors(record[key], schema.additionalProperties, root, `${path}${key}.`));
				}
			}
		}
	}

	switch (schema.type) {
		case "boolean": {
			if (typeof value !== "boolean") errors.push(`${path}: must be a boolean`);
			break;
		}
		case "string": {
			if (typeof value !== "string") {
				errors.push(`${path}: must be a string`);
				break;
			}
			if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
			if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`);
			if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
				errors.push(`${path}: does not match pattern`);
			break;
		}
		case "integer": {
			if (typeof value !== "number" || !Number.isInteger(value)) {
				errors.push(`${path}: must be an integer`);
				break;
			}
			if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
			break;
		}
		case "array": {
			if (!Array.isArray(value)) {
				errors.push(`${path}: must be an array`);
				break;
			}
			if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
			if (schema.items) {
				value.forEach((entry, index) => {
					errors.push(...schemaErrors(entry, schema.items as JsonSchemaNode, root, `${path}[${index}].`));
				});
			}
			break;
		}
	}

	return errors;
}
