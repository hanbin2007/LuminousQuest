import { z } from 'zod';

const idSchema = z.string().trim().min(1);
const versionSchema = z.string().trim().regex(/\.v\d+$/, 'must end with a numeric .v version');

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

export const knowledgeModelSchema = z
  .object({
    version: versionSchema,
    dimensions: z
      .array(
        z.object({
          id: idSchema,
          label: z.string().trim().min(1),
          axis: z.enum(['x', 'y', 'z']),
        }),
      )
      .min(3),
    nodes: z
      .array(
        z.object({
          id: idSchema,
          dimensionId: idSchema,
          statement: z.string().trim().min(1),
          misconceptions: z.array(z.string().trim().min(1)),
          weight: z.union([z.literal(1), z.literal(2)]),
          position: positionSchema,
          dependsOn: z.array(idSchema).default([]),
        }),
      )
      .min(1),
    edges: z.array(
      z.object({
        id: idSchema,
        from: idSchema,
        to: idSchema,
        kind: z.enum(['dependency', 'cross-axis']),
      }),
    ),
  })
  .superRefine((value, context) => {
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
      node.dependsOn.forEach((dependency, dependencyIndex) => {
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

const rubricRuleSchema = z.object({
  id: idSchema,
  outcome: z.enum(['hit', 'partial', 'miss']),
  score: z.number().nonnegative(),
  description: z.string().trim().min(1),
});

export const rubricsSchema = z.object({
  version: versionSchema,
  rubrics: z
    .array(
      z.object({
        id: idSchema,
        nodeId: idSchema,
        maxScore: z.number().positive(),
        evidenceRequirements: z.array(z.string().trim().min(1)).min(1),
        rules: z.array(rubricRuleSchema).min(1),
      }),
    )
    .min(1),
});

const builderComponentSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1),
  kind: z.enum(['electrode', 'wire', 'ion-conductor', 'meter', 'distractor']),
});

const pretestQuestionSchema = z.object({
  id: idSchema,
  type: z.enum(['builder', 'text', 'canvas']),
  prompt: z.string().trim().min(1),
  rubricIds: z.array(idSchema).min(1),
});

export const pretestSchema = z.object({
  version: versionSchema,
  builder: z.object({
    components: z.array(builderComponentSchema).min(1),
    structuralRules: z
      .array(
        z.object({
          id: idSchema,
          description: z.string().trim().min(1),
          requiredComponentIds: z.array(idSchema).min(1),
        }),
      )
      .min(1),
  }),
  questions: z.array(pretestQuestionSchema).length(3),
});

export const caseSchema = z.object({
  version: versionSchema,
  id: idSchema,
  title: z.string().trim().min(1),
  type: z.enum(['analysis', 'design']),
  materialRefs: z.array(z.string().trim().min(1)),
  scaffold: z
    .array(
      z.object({
        level: z.number().int().positive(),
        questions: z.array(z.string().trim().min(1)).min(1),
        answerPoints: z.array(z.string().trim().min(1)).min(1),
      }),
    )
    .min(1),
  targetNodeIds: z.array(idSchema).min(1),
});

export const scaffoldPolicySchema = z.object({
  version: versionSchema,
  levels: z
    .array(
      z.object({
        level: z.number().int().positive(),
        label: z.string().trim().min(1),
        promptCount: z.number().int().nonnegative(),
      }),
    )
    .min(1),
  promotion: z.object({
    consecutiveHits: z.number().int().positive(),
  }),
  demotion: z.object({
    consecutiveMisses: z.number().int().positive(),
  }),
  selection: z.object({
    weakNodeThreshold: z.number().min(0).max(1),
    recentCaseWindow: z.number().int().positive(),
  }),
});

export type KnowledgeModelConfig = z.infer<typeof knowledgeModelSchema>;
export type RubricsConfig = z.infer<typeof rubricsSchema>;
export type PretestConfig = z.infer<typeof pretestSchema>;
export type CaseConfig = z.infer<typeof caseSchema>;
export type ScaffoldPolicyConfig = z.infer<typeof scaffoldPolicySchema>;

export interface LoadedConfig {
  knowledgeModel: KnowledgeModelConfig;
  rubrics: RubricsConfig;
  pretest: PretestConfig;
  cases: CaseConfig[];
  scaffoldPolicy: ScaffoldPolicyConfig;
}

