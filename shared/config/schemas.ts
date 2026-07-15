import { z } from 'zod';

const idSchema = z.string().trim().min(1);
const versionSchema = z.string().trim().regex(/\.v\d+$/, 'must end with a numeric .v version');

function reportDuplicateIds(
  values: readonly { id: string }[],
  path: readonly (string | number)[],
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) {
      context.addIssue({
        code: 'custom',
        path: [...path, index, 'id'],
        message: `duplicate id ${value.id}`,
      });
    }
    seen.add(value.id);
  });
}

const positionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();

export const knowledgeModelSchema = z
  .object({
    version: versionSchema,
    dimensions: z
      .array(
        z
          .object({
            id: idSchema,
            label: z.string().trim().min(1),
            axis: z.enum(['x', 'y', 'z']),
          })
          .strict(),
      )
      .min(3),
    nodes: z
      .array(
        z
          .object({
            id: idSchema,
            dimensionId: idSchema,
            statement: z.string().trim().min(1),
            misconceptions: z.array(z.string().trim().min(1)),
            weight: z.union([z.literal(1), z.literal(2)], {
              error: 'must be 1 (secondary) or 2 (core)',
            }),
            position: positionSchema,
            dependsOn: z.array(idSchema).default([]),
          })
          .strict(),
      )
      .min(1),
    edges: z.array(
      z
        .object({
          id: idSchema,
          from: idSchema,
          to: idSchema,
          kind: z.enum(['dependency', 'cross-axis']),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicateIds(value.dimensions, ['dimensions'], context);
    reportDuplicateIds(value.nodes, ['nodes'], context);
    reportDuplicateIds(value.edges, ['edges'], context);

    const dimensionIds = new Set(value.dimensions.map((dimension) => dimension.id));
    const nodeIds = new Set(value.nodes.map((node) => node.id));

    value.nodes.forEach((node, index) => {
      if (!dimensionIds.has(node.dimensionId)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'dimensionId'],
          message: `unknown dimension ${node.dimensionId}`,
        });
      }
      const dependencies = new Set<string>();
      node.dependsOn.forEach((dependency, dependencyIndex) => {
        if (dependencies.has(dependency)) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'dependsOn', dependencyIndex],
            message: `duplicate node reference ${dependency}`,
          });
        }
        dependencies.add(dependency);
        if (!nodeIds.has(dependency)) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'dependsOn', dependencyIndex],
            message: `unknown node ${dependency}`,
          });
        }
      });
    });

    value.edges.forEach((edge, index) => {
      for (const endpoint of ['from', 'to'] as const) {
        if (!nodeIds.has(edge[endpoint])) {
          context.addIssue({
            code: 'custom',
            path: ['edges', index, endpoint],
            message: `unknown node ${edge[endpoint]}`,
          });
        }
      }
    });
  });

const rubricRuleSchema = z
  .object({
    id: idSchema,
    outcome: z.enum(['hit', 'partial', 'miss']),
    score: z.number().nonnegative(),
    description: z.string().trim().min(1),
  })
  .strict();

export const rubricsSchema = z
  .object({
    version: versionSchema,
    rubrics: z
      .array(
        z
          .object({
            id: idSchema,
            nodeId: idSchema,
            maxScore: z.number().positive(),
            evidenceRequirements: z.array(z.string().trim().min(1)).min(1),
            rules: z.array(rubricRuleSchema).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicateIds(value.rubrics, ['rubrics'], context);
    value.rubrics.forEach((rubric, rubricIndex) => {
      reportDuplicateIds(rubric.rules, ['rubrics', rubricIndex, 'rules'], context);
      rubric.rules.forEach((rule, ruleIndex) => {
        if (rule.score > rubric.maxScore) {
          context.addIssue({
            code: 'custom',
            path: ['rubrics', rubricIndex, 'rules', ruleIndex, 'score'],
            message: `rule score cannot exceed maxScore ${rubric.maxScore}`,
          });
        }
      });
    });
  });

const builderComponentSchema = z
  .object({
    id: idSchema,
    label: z.string().trim().min(1),
    kind: z.enum(['electrode', 'wire', 'ion-conductor', 'meter', 'distractor']),
  })
  .strict();

const pretestQuestionSchema = z
  .object({
    id: idSchema,
    type: z.enum(['builder', 'text', 'canvas']),
    prompt: z.string().trim().min(1),
    rubricIds: z.array(idSchema).min(1),
  })
  .strict();

export const pretestSchema = z
  .object({
    version: versionSchema,
    builder: z
      .object({
        components: z.array(builderComponentSchema).min(1),
        structuralRules: z
          .array(
            z
              .object({
                id: idSchema,
                description: z.string().trim().min(1),
                requiredComponentIds: z.array(idSchema).min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    questions: z.array(pretestQuestionSchema).length(3),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicateIds(value.builder.components, ['builder', 'components'], context);
    reportDuplicateIds(value.builder.structuralRules, ['builder', 'structuralRules'], context);
    reportDuplicateIds(value.questions, ['questions'], context);
    const componentIds = new Set(value.builder.components.map((component) => component.id));
    value.builder.structuralRules.forEach((rule, ruleIndex) => {
      const references = new Set<string>();
      rule.requiredComponentIds.forEach((componentId, componentIndex) => {
        const path = ['builder', 'structuralRules', ruleIndex, 'requiredComponentIds', componentIndex];
        if (references.has(componentId)) {
          context.addIssue({ code: 'custom', path, message: `duplicate component reference ${componentId}` });
        }
        references.add(componentId);
        if (!componentIds.has(componentId)) {
          context.addIssue({ code: 'custom', path, message: `unknown component ${componentId}` });
        }
      });
    });
    value.questions.forEach((question, questionIndex) => {
      const seen = new Set<string>();
      question.rubricIds.forEach((rubricId, rubricIndex) => {
        if (seen.has(rubricId)) {
          context.addIssue({
            code: 'custom',
            path: ['questions', questionIndex, 'rubricIds', rubricIndex],
            message: `duplicate rubric reference ${rubricId}`,
          });
        }
        seen.add(rubricId);
      });
    });
  });

export const caseSchema = z
  .object({
    version: versionSchema,
    id: idSchema,
    title: z.string().trim().min(1),
    type: z.enum(['analysis', 'design']),
    materialRefs: z.array(z.string().trim().min(1)),
    scaffold: z
      .array(
        z
          .object({
            level: z.number().int().positive(),
            questions: z.array(z.string().trim().min(1)).min(1),
            answerPoints: z.array(z.string().trim().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    targetNodeIds: z.array(idSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, entries] of [
      ['materialRefs', value.materialRefs],
      ['targetNodeIds', value.targetNodeIds],
    ] as const) {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        if (seen.has(entry)) {
          context.addIssue({ code: 'custom', path: [field, index], message: `duplicate reference ${entry}` });
        }
        seen.add(entry);
      });
    }
    const levels = new Set<number>();
    value.scaffold.forEach((entry, index) => {
      if (levels.has(entry.level)) {
        context.addIssue({
          code: 'custom',
          path: ['scaffold', index, 'level'],
          message: `duplicate scaffold level ${entry.level}`,
        });
      }
      levels.add(entry.level);
    });
  });

export const scaffoldPolicySchema = z
  .object({
    version: versionSchema,
    levels: z
      .array(
        z
          .object({
            level: z.number().int().positive(),
            label: z.string().trim().min(1),
            promptCount: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1),
    promotion: z.object({ consecutiveHits: z.number().int().positive() }).strict(),
    demotion: z.object({ consecutiveMisses: z.number().int().positive() }).strict(),
    selection: z
      .object({
        weakNodeThreshold: z.number().min(0).max(1),
        recentCaseWindow: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const levels = new Set<number>();
    value.levels.forEach((entry, index) => {
      if (levels.has(entry.level)) {
        context.addIssue({
          code: 'custom',
          path: ['levels', index, 'level'],
          message: `duplicate scaffold level ${entry.level}`,
        });
      }
      levels.add(entry.level);
    });
  });

export type KnowledgeModelConfig = z.infer<typeof knowledgeModelSchema>;
export type RubricsConfig = z.infer<typeof rubricsSchema>;
export type PretestConfig = z.infer<typeof pretestSchema>;
export type CaseConfig = z.infer<typeof caseSchema>;
export type ScaffoldPolicyConfig = z.infer<typeof scaffoldPolicySchema>;

export interface LoadedConfig {
  configVersion: string;
  knowledgeModel: KnowledgeModelConfig;
  rubrics: RubricsConfig;
  pretest: PretestConfig;
  cases: CaseConfig[];
  scaffoldPolicy: ScaffoldPolicyConfig;
}
