/**
 * Unit tests for the portable field-rule helpers that every kit's schema
 * builder shares. Pure: no driver, no introspection. Locks policy semantics
 * (immutable / systemManaged / optional / explicit omit) so mongokit and
 * sqlitekit behave identically against the same SchemaBuilderOptions.
 */

import { describe, expect, it } from 'vitest';

import {
  applyFieldRules,
  collectFieldsToOmit,
  getImmutableFields,
  getSystemManagedFields,
  isFieldUpdateAllowed,
  validateUpdateBody,
} from '../../../src/schema/field-rules.js';
import type { JsonSchema, SchemaBuilderOptions } from '../../../src/schema/types.js';

describe('schema/field-rules', () => {
  describe('collectFieldsToOmit', () => {
    it('always hides the timestamp + version trio', () => {
      expect(collectFieldsToOmit({}, 'create')).toEqual(new Set(['createdAt', 'updatedAt', '__v']));
      expect(collectFieldsToOmit({}, 'update')).toEqual(new Set(['createdAt', 'updatedAt', '__v']));
    });

    it('adds systemManaged fields to both create and update', () => {
      const options: SchemaBuilderOptions = {
        fieldRules: {
          status: { systemManaged: true },
        },
      };
      expect(collectFieldsToOmit(options, 'create')).toContain('status');
      expect(collectFieldsToOmit(options, 'update')).toContain('status');
    });

    it('adds immutable fields to update only — create still lets them through', () => {
      const options: SchemaBuilderOptions = {
        fieldRules: {
          tenantId: { immutable: true },
        },
      };
      expect(collectFieldsToOmit(options, 'create').has('tenantId')).toBe(false);
      expect(collectFieldsToOmit(options, 'update').has('tenantId')).toBe(true);
    });

    it('honors immutableAfterCreate as an alias of immutable', () => {
      const options: SchemaBuilderOptions = {
        fieldRules: {
          orgId: { immutableAfterCreate: true },
        },
      };
      expect(collectFieldsToOmit(options, 'update').has('orgId')).toBe(true);
      expect(collectFieldsToOmit(options, 'create').has('orgId')).toBe(false);
    });

    it('merges explicit create.omitFields / update.omitFields', () => {
      const options: SchemaBuilderOptions = {
        create: { omitFields: ['internalFlag'] },
        update: { omitFields: ['customerId'] },
      };
      expect(collectFieldsToOmit(options, 'create').has('internalFlag')).toBe(true);
      expect(collectFieldsToOmit(options, 'create').has('customerId')).toBe(false);
      expect(collectFieldsToOmit(options, 'update').has('customerId')).toBe(true);
      expect(collectFieldsToOmit(options, 'update').has('internalFlag')).toBe(false);
    });

    it('returns a fresh Set each call (caller-mutable)', () => {
      const a = collectFieldsToOmit({}, 'create');
      const b = collectFieldsToOmit({}, 'create');
      a.add('pollutant');
      expect(b.has('pollutant')).toBe(false);
    });
  });

  describe('applyFieldRules', () => {
    it('removes omitted fields from properties and required', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { name: { type: 'string' }, secret: { type: 'string' } },
        required: ['name', 'secret'],
      };
      applyFieldRules(schema, new Set(['secret']), {});
      expect(schema.properties).toEqual({ name: { type: 'string' } });
      expect(schema.required).toEqual(['name']);
    });

    it('strips fieldRules.optional fields from required but keeps them in properties', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { email: { type: 'string' }, phone: { type: 'string' } },
        required: ['email', 'phone'],
      };
      applyFieldRules(schema, new Set(), {
        fieldRules: { phone: { optional: true } },
      });
      expect(schema.properties).toEqual({
        email: { type: 'string' },
        phone: { type: 'string' },
      });
      expect(schema.required).toEqual(['email']);
    });

    it('is safe when required is undefined', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
      };
      expect(() => applyFieldRules(schema, new Set(['name']), {})).not.toThrow();
      expect(schema.properties).toEqual({});
    });
  });

  describe('getImmutableFields', () => {
    it('returns rules + update.omitFields, deduplicated', () => {
      const options: SchemaBuilderOptions = {
        fieldRules: {
          tenantId: { immutable: true },
          createdBy: { immutableAfterCreate: true },
        },
        update: { omitFields: ['tenantId', 'slug'] },
      };
      const result = getImmutableFields(options);
      expect(result).toEqual(['tenantId', 'createdBy', 'slug']);
    });

    it('returns empty array for empty options', () => {
      expect(getImmutableFields()).toEqual([]);
      expect(getImmutableFields({})).toEqual([]);
    });
  });

  describe('getSystemManagedFields', () => {
    it('returns only systemManaged entries', () => {
      const options: SchemaBuilderOptions = {
        fieldRules: {
          status: { systemManaged: true },
          tenantId: { immutable: true },
          score: { systemManaged: true },
        },
      };
      expect(getSystemManagedFields(options).sort()).toEqual(['score', 'status']);
    });
  });

  describe('isFieldUpdateAllowed', () => {
    it('blocks immutable and system-managed fields', () => {
      const options: SchemaBuilderOptions = {
        fieldRules: {
          tenantId: { immutable: true },
          status: { systemManaged: true },
        },
      };
      expect(isFieldUpdateAllowed('tenantId', options)).toBe(false);
      expect(isFieldUpdateAllowed('status', options)).toBe(false);
      expect(isFieldUpdateAllowed('name', options)).toBe(true);
    });
  });

  describe('validateUpdateBody', () => {
    it('reports violations for immutable and system-managed fields', () => {
      const options: SchemaBuilderOptions = {
        fieldRules: {
          tenantId: { immutable: true },
          status: { systemManaged: true },
        },
      };
      const result = validateUpdateBody(
        { name: 'New Name', tenantId: 'other', status: 'active' },
        options,
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual([
        { field: 'tenantId', reason: 'Field is immutable' },
        { field: 'status', reason: 'Field is system-managed' },
      ]);
    });

    it('passes when only allowed fields are present', () => {
      const result = validateUpdateBody(
        { name: 'New Name' },
        { fieldRules: { tenantId: { immutable: true } } },
      );
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('handles empty body + no options', () => {
      expect(validateUpdateBody()).toEqual({ valid: true, violations: [] });
    });
  });
});
