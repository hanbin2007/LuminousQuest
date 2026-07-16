import { z } from 'zod';

const idSchema = z.string().trim().min(1);
const versionSchema = z.string().trim().regex(
  /\.v\d+(?:\.\d+)*$/,
  'must end with a numeric .v version',
);
const outcomeSchema = z.enum(['hit', 'partial', 'miss']);
const dimensionIdSchema = z.enum(['device', 'principle', 'energy']);

export const functionalRoleSchema = z.enum([
  'oxidation-site',
  'electron-conductor',
  'ion-conductor',
  'reduction-site',
]);

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

function reportDuplicateStrings(
  values: readonly string[],
  path: readonly (string | number)[],
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({ code: 'custom', path: [...path, index], message: `duplicate reference ${value}` });
    }
    seen.add(value);
  });
}

const positionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();

const misconceptionSchema = z
  .object({
    id: idSchema,
    statement: z.string().trim().min(1),
  })
  .strict();

export const knowledgeModelSchema = z
  .object({
    version: versionSchema,
    dimensions: z
      .array(
        z
          .object({
            id: dimensionIdSchema,
            label: z.string().trim().min(1),
            axis: z.enum(['x', 'y', 'z']),
          })
          .strict(),
      )
      .length(3),
    nodes: z
      .array(
        z
          .object({
            id: idSchema,
            dimensionId: dimensionIdSchema,
            statement: z.string().trim().min(1),
            misconceptions: z.array(misconceptionSchema).min(1),
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

    const axes = new Set<string>();
    value.dimensions.forEach((dimension, index) => {
      if (axes.has(dimension.axis)) {
        context.addIssue({
          code: 'custom',
          path: ['dimensions', index, 'axis'],
          message: `duplicate axis ${dimension.axis}`,
        });
      }
      axes.add(dimension.axis);
    });

    const dimensionIds = new Set(value.dimensions.map((dimension) => dimension.id));
    const nodeIds = new Set(value.nodes.map((node) => node.id));
    const misconceptionIds = new Set<string>();

    value.nodes.forEach((node, index) => {
      if (!dimensionIds.has(node.dimensionId)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'dimensionId'],
          message: `unknown dimension ${node.dimensionId}`,
        });
      }
      reportDuplicateIds(node.misconceptions, ['nodes', index, 'misconceptions'], context);
      node.misconceptions.forEach((misconception, misconceptionIndex) => {
        if (misconceptionIds.has(misconception.id)) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'misconceptions', misconceptionIndex, 'id'],
            message: `duplicate id ${misconception.id}`,
          });
        }
        misconceptionIds.add(misconception.id);
      });
      reportDuplicateStrings(node.dependsOn, ['nodes', index, 'dependsOn'], context);
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

const rubricRuleSchema = z
  .object({
    id: idSchema,
    outcome: outcomeSchema,
    score: z.number().nonnegative(),
    description: z.string().trim().min(1),
  })
  .strict();

const evidenceRequirementSchema = z
  .object({
    id: idSchema,
    description: z.string().trim().min(1),
    sources: z
      .array(z.enum(['builder', 'choice', 'text', 'equation', 'case-analysis']))
      .min(1),
  })
  .strict();

const adjudicationIds = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
  '13', '14', '15', '16', '17', '18', '18b', '18c', '19', '19b', '20',
] as const;

const adjudicationSchema = z
  .object({
    id: z.enum(adjudicationIds),
    configField: z.string().trim().min(1),
    status: z.enum(['teacher-confirmed', 'teacher-tuning']),
    source: z.enum(['given-default', 'model-decision', 'developer-default']),
    reviewDueAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

const rubricPolicySchema = z
  .object({
    outcomeScale: z
      .object({
        mode: z.enum(['two-state', 'three-state']),
        partialDefinition: z.string().trim().min(1),
      })
      .strict(),
    followingError: z
      .object({
        strategy: z.enum(['score-logical-chain', 'score-objective-fact']),
        annotation: z.string().trim().min(1),
        anchorId: idSchema,
      })
      .strict(),
    terminology: z
      .object({
        colloquialCorrectOutcome: outcomeSchema,
        requireModelTermsForHit: z.boolean(),
      })
      .strict(),
    beyondSyllabus: z
      .object({ correctOutcome: outcomeSchema, bonusPoints: z.number().nonnegative() })
      .strict(),
    contradiction: z.object({ outcome: outcomeSchema }).strict(),
    nonResponse: z
      .object({
        status: z.enum(['unanswered', 'miss']),
        promptRetry: z.boolean(),
        includeInDiagnosis: z.boolean(),
      })
      .strict(),
    typos: z
      .object({
        unambiguousStrategy: z.enum(['ignore', 'warn-no-penalty', 'penalize']),
        ambiguousStrategy: z.enum(['needs-review', 'miss']),
      })
      .strict(),
    equation: z
      .object({
        mediumMismatchOutcome: outcomeSchema,
        feedbackNodeId: idSchema,
        acceptEqualsSign: z.boolean(),
        requireEquilibriumArrow: z.boolean(),
        requireStates: z.boolean(),
      })
      .strict(),
    weighting: z
      .object({
        dimensionMode: z.enum(['equal', 'node-weighted']),
        coreWeight: z.literal(2),
        secondaryWeight: z.literal(1),
        nodeOverrides: z.record(idSchema, z.union([z.literal(1), z.literal(2)])),
      })
      .strict(),
    weakness: z
      .object({
        threshold: z.number().min(0).max(1),
        partialVisualization: z.enum(['half-lit', 'dark', 'full-lit']),
      })
      .strict(),
    repeatedAnswers: z.object({ strategy: z.enum(['latest', 'best', 'worst']) }).strict(),
    dimensionAssignments: z
      .object({
        spontaneousRedox: dimensionIdSchema,
        saltBridge: idSchema,
        siteReactantDistinction: z.enum(['D5-cross-axis', 'device-only', 'principle-only']),
      })
      .strict(),
    presentation: z
      .object({
        studentRadar: z.enum(['score', 'level', 'score-and-level']),
        classSummary: z.array(z.enum(['radar-distribution', 'node-error-ranking', 'misconception-top-n'])).min(1),
      })
      .strict(),
  })
  .strict();

export const rubricsSchema = z
  .object({
    version: versionSchema,
    followingAnchors: z
      .array(
        z
          .object({
            id: idSchema,
            label: z.string().trim().min(1),
            description: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
    policy: rubricPolicySchema,
    adjudications: z.array(adjudicationSchema).length(adjudicationIds.length),
    rubrics: z
      .array(
        z
          .object({
            id: idSchema,
            nodeId: idSchema,
            maxScore: z.number().positive(),
            evidenceRequirements: z.array(evidenceRequirementSchema).min(1),
            followingAnchorId: idSchema.optional(),
            rules: z.array(rubricRuleSchema).length(3),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicateIds(value.followingAnchors, ['followingAnchors'], context);
    reportDuplicateIds(value.adjudications, ['adjudications'], context);
    reportDuplicateIds(value.rubrics, ['rubrics'], context);
    const decisionIds = new Set(value.adjudications.map((entry) => entry.id));
    adjudicationIds.forEach((id) => {
      if (!decisionIds.has(id)) {
        context.addIssue({ code: 'custom', path: ['adjudications'], message: `missing adjudication ${id}` });
      }
    });
    value.adjudications.forEach((entry, index) => {
      if (entry.status === 'teacher-confirmed' && entry.reviewDueAt !== null) {
        context.addIssue({
          code: 'custom',
          path: ['adjudications', index, 'reviewDueAt'],
          message: 'confirmed adjudication cannot have a pending review deadline',
        });
      }
      if (entry.status === 'teacher-tuning' && entry.reviewDueAt === null) {
        context.addIssue({
          code: 'custom',
          path: ['adjudications', index, 'reviewDueAt'],
          message: 'teacher-tuning adjudication requires a review deadline',
        });
      }
    });

    const anchorIds = new Set(value.followingAnchors.map((anchor) => anchor.id));
    const ruleIds = new Set<string>();
    value.rubrics.forEach((rubric, rubricIndex) => {
      reportDuplicateIds(rubric.evidenceRequirements, ['rubrics', rubricIndex, 'evidenceRequirements'], context);
      reportDuplicateIds(rubric.rules, ['rubrics', rubricIndex, 'rules'], context);
      const outcomes = new Set(rubric.rules.map((rule) => rule.outcome));
      for (const outcome of outcomeSchema.options) {
        if (!outcomes.has(outcome)) {
          context.addIssue({
            code: 'custom',
            path: ['rubrics', rubricIndex, 'rules'],
            message: `missing ${outcome} rule`,
          });
        }
      }
      if (rubric.followingAnchorId && !anchorIds.has(rubric.followingAnchorId)) {
        context.addIssue({
          code: 'custom',
          path: ['rubrics', rubricIndex, 'followingAnchorId'],
          message: `unknown following anchor ${rubric.followingAnchorId}`,
        });
      }
      rubric.rules.forEach((rule, ruleIndex) => {
        if (ruleIds.has(rule.id)) {
          context.addIssue({
            code: 'custom',
            path: ['rubrics', rubricIndex, 'rules', ruleIndex, 'id'],
            message: `duplicate id ${rule.id}`,
          });
        }
        ruleIds.add(rule.id);
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
    kind: z.enum([
      'electrode',
      'electron-conductor',
      'ion-conductor',
      'container',
      'direction-marker',
      'meter',
      'distractor',
    ]),
    functionalRole: functionalRoleSchema.optional(),
    allowedRoles: z.array(functionalRoleSchema).default([]),
    saltBridge: z.boolean().default(false),
    abstract: z.boolean(),
    distractor: z
      .object({
        misconceptionIds: z.array(idSchema).min(1),
        reason: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const kindRoles: Record<typeof value.kind, readonly FunctionalRole[]> = {
      electrode: ['oxidation-site', 'reduction-site'],
      'electron-conductor': ['electron-conductor'],
      'ion-conductor': ['ion-conductor'],
      container: [],
      'direction-marker': [],
      meter: [],
      distractor: ['electron-conductor', 'ion-conductor'],
    };
    const allowedForKind = new Set(kindRoles[value.kind]);
    const configuredRoles = [value.functionalRole, ...value.allowedRoles]
      .filter((role): role is FunctionalRole => role !== undefined);
    configuredRoles.forEach((role, index) => {
      if (!allowedForKind.has(role)) {
        context.addIssue({
          code: 'custom',
          path: index === 0 && value.functionalRole ? ['functionalRole'] : ['allowedRoles', index],
          message: `role ${role} is not allowed for component kind ${value.kind}`,
        });
      }
    });
    if (value.saltBridge && value.kind !== 'ion-conductor') {
      context.addIssue({
        code: 'custom',
        path: ['saltBridge'],
        message: 'only an ion-conductor can be a salt bridge',
      });
    }
  });

const structuralRuleSchema = z
  .object({
    id: idSchema,
    description: z.string().trim().min(1),
    check: z.enum(['four-elements', 'closed-circuit', 'direction-consistency', 'abstraction']),
    requiredComponentIds: z.array(idSchema),
    nodeIds: z.array(idSchema).min(1),
  })
  .strict();

const questionBaseShape = {
  id: idSchema,
  prompt: z.string().trim().min(1),
  dimensionId: dimensionIdSchema,
  rubricIds: z.array(idSchema).min(1),
  targetNodeIds: z.array(idSchema).min(1),
  evidencePath: z.string().trim().min(1),
};

const choiceQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('choice'),
    options: z
      .array(
        z
          .object({
            id: idSchema,
            text: z.string().trim().min(1),
            correct: z.boolean(),
            misconceptionIds: z.array(idSchema),
          })
          .strict(),
      )
      .min(2),
  })
  .strict()
  .refine((question) => question.options.filter((option) => option.correct).length === 1, {
    path: ['options'],
    message: 'choice question must have exactly one correct option',
  });

const textQuestionSchema = z
  .object({
    ...questionBaseShape,
    type: z.literal('text'),
    answerGuidance: z.array(z.string().trim().min(1)).min(1),
    referenceEquations: z
      .array(
        z
          .object({
            caseId: idSchema,
            equationSetId: idSchema,
            equation: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const pretestQuestionSchema = z.union([choiceQuestionSchema, textQuestionSchema]);

export const pretestSchema = z
  .object({
    version: versionSchema,
    builder: z
      .object({
        prompt: z.string().trim().min(1),
        components: z.array(builderComponentSchema).min(1),
        structuralRules: z.array(structuralRuleSchema).length(4),
        assessment: z
          .object({
            generalModel: z
              .object({
                requiredRoles: z.array(functionalRoleSchema).length(4),
                saltBridgeRequired: z.boolean(),
                requireClosedElectronPath: z.boolean(),
                requireClosedIonPath: z.boolean(),
              })
              .strict(),
            direction: z
              .object({
                electronFrom: functionalRoleSchema,
                electronTo: functionalRoleSchema,
                cationToward: functionalRoleSchema,
                anionToward: functionalRoleSchema,
              })
              .strict(),
            abstraction: z
              .object({
                concreteBindingOutcome: outcomeSchema,
                concreteLabels: z.array(z.string().trim().min(1)).min(1),
                feedback: z.string().trim().min(1),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    questions: z.array(pretestQuestionSchema).length(3),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicateIds(value.builder.components, ['builder', 'components'], context);
    reportDuplicateIds(value.builder.structuralRules, ['builder', 'structuralRules'], context);
    reportDuplicateIds(value.questions, ['questions'], context);
    reportDuplicateStrings(
      value.builder.assessment.generalModel.requiredRoles,
      ['builder', 'assessment', 'generalModel', 'requiredRoles'],
      context,
    );
    const componentIds = new Set(value.builder.components.map((component) => component.id));
    value.builder.structuralRules.forEach((rule, ruleIndex) => {
      reportDuplicateStrings(
        rule.requiredComponentIds,
        ['builder', 'structuralRules', ruleIndex, 'requiredComponentIds'],
        context,
      );
      rule.requiredComponentIds.forEach((componentId, componentIndex) => {
        if (!componentIds.has(componentId)) {
          context.addIssue({
            code: 'custom',
            path: ['builder', 'structuralRules', ruleIndex, 'requiredComponentIds', componentIndex],
            message: `unknown component ${componentId}`,
          });
        }
      });
    });
    value.questions.forEach((question, questionIndex) => {
      reportDuplicateStrings(question.rubricIds, ['questions', questionIndex, 'rubricIds'], context);
      reportDuplicateStrings(question.targetNodeIds, ['questions', questionIndex, 'targetNodeIds'], context);
      if (question.type === 'choice') {
        reportDuplicateIds(question.options, ['questions', questionIndex, 'options'], context);
      }
    });
  });

const caseMaterialSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['apparatus-diagram', 'cross-section']),
    materialRef: z.string().trim().startsWith('assets/').nullable(),
    status: z.enum(['pending-assets', 'ready']),
    revealAfterNodeIds: z.array(idSchema).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'ready' && value.materialRef === null) {
      context.addIssue({ code: 'custom', path: ['materialRef'], message: 'ready material requires materialRef' });
    }
    if (value.status === 'pending-assets' && value.materialRef !== null) {
      context.addIssue({ code: 'custom', path: ['materialRef'], message: 'pending materialRef must be null' });
    }
    if (value.kind === 'cross-section' && value.revealAfterNodeIds.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['revealAfterNodeIds'],
        message: 'cross-section material requires a configured reveal condition',
      });
    }
  });

const equationSetSchema = z
  .object({
    id: idSchema,
    electrode: z.enum(['negative', 'positive', 'overall']),
    medium: z.enum(['acidic', 'alkaline', 'neutral', 'molten']),
    expectedElectronSide: z.enum(['reactant', 'product', 'none']),
    accepted: z.array(z.string().trim().min(1)).min(1),
    crossMediumAccepted: z
      .array(
        z
          .object({
            medium: z.enum(['acidic', 'alkaline', 'neutral', 'molten']),
            accepted: z.array(z.string().trim().min(1)).min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const scaffoldLevelOneSchema = z
  .object({
    level: z.literal(1),
    fields: z
      .array(
        z
          .object({
            id: idSchema,
            dimensionId: dimensionIdSchema,
            nodeId: idSchema,
            prompt: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
    answerPoints: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicateIds(value.fields, ['fields'], context);
  });

const scaffoldLevelTwoSchema = z
  .object({
    level: z.literal(2),
    dimensionIds: z.array(dimensionIdSchema).length(3),
    answerPoints: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicateStrings(value.dimensionIds, ['dimensionIds'], context);
  });

const scaffoldLevelThreeSchema = z
  .object({
    level: z.literal(3),
    prompt: z.string().trim().min(1),
    answerPoints: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const caseScaffoldSchema = z.discriminatedUnion('level', [
  scaffoldLevelOneSchema,
  scaffoldLevelTwoSchema,
  scaffoldLevelThreeSchema,
]);

export const caseSchema = z
  .object({
    version: versionSchema,
    id: idSchema,
    sequence: z.number().int().positive(),
    title: z.string().trim().min(1),
    type: z.enum(['analysis', 'design']),
    caseType: z.enum(['training', 'transfer']),
    medium: z.enum(['acidic', 'alkaline', 'neutral', 'molten']),
    materials: z.array(caseMaterialSchema).min(1),
    followingAnchors: z
      .array(
        z
          .object({
            id: idSchema,
            statement: z.string().trim().min(1),
            correctValue: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
    scaffold: z.array(caseScaffoldSchema).length(3),
    equationSets: z.array(equationSetSchema).length(3),
    tutoring: z
      .array(
        z
          .object({ nodeId: idSchema })
          .strict(),
      )
      .default([]),
    evidencePaths: z
      .array(
        z
          .object({
            id: idSchema,
            nodeId: idSchema,
            description: z.string().trim().min(1),
            source: z.enum(['answer', 'equation', 'builder']),
            referenceAnswerPoints: z.array(z.string().trim().min(1)).default([]),
            factRequirements: z
              .array(
                z
                  .object({
                    id: idSchema,
                    acceptedValues: z.array(z.string().trim().min(1)).min(1),
                  })
                  .strict(),
              )
              .default([]),
          })
          .strict(),
      )
      .min(1),
    targetNodeIds: z.array(idSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicateIds(value.materials, ['materials'], context);
    reportDuplicateIds(value.followingAnchors, ['followingAnchors'], context);
    reportDuplicateIds(value.equationSets, ['equationSets'], context);
    reportDuplicateStrings(value.tutoring.map((entry) => entry.nodeId), ['tutoring'], context);
    reportDuplicateIds(value.evidencePaths, ['evidencePaths'], context);
    reportDuplicateStrings(value.targetNodeIds, ['targetNodeIds'], context);
    value.materials.forEach((material, materialIndex) => {
      reportDuplicateStrings(
        material.revealAfterNodeIds,
        ['materials', materialIndex, 'revealAfterNodeIds'],
        context,
      );
      material.revealAfterNodeIds.forEach((nodeId, nodeIndex) => {
        if (!value.targetNodeIds.includes(nodeId)) {
          context.addIssue({
            code: 'custom',
            path: ['materials', materialIndex, 'revealAfterNodeIds', nodeIndex],
            message: `material reveal targets non-case node ${nodeId}`,
          });
        }
      });
    });
    if (value.caseType === 'transfer' && value.tutoring.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['tutoring'],
        message: 'transfer case cannot configure Socratic tutoring',
      });
    }
    const electrodeCounts = new Map<'negative' | 'positive' | 'overall', number>([
      ['negative', 0],
      ['positive', 0],
      ['overall', 0],
    ]);
    value.equationSets.forEach((entry) => {
      electrodeCounts.set(entry.electrode, electrodeCounts.get(entry.electrode)! + 1);
    });
    electrodeCounts.forEach((count, electrode) => {
      if (count !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['equationSets'],
          message: `case must contain exactly one ${electrode} equation set`,
        });
      }
    });
    const evidenceNodeIds = new Set(value.evidencePaths.map((entry) => entry.nodeId));
    value.targetNodeIds.forEach((nodeId, index) => {
      if (!evidenceNodeIds.has(nodeId)) {
        context.addIssue({
          code: 'custom',
          path: ['targetNodeIds', index],
          message: `target node ${nodeId} has no evidence path`,
        });
      }
    });
    value.evidencePaths.forEach((entry, index) => {
      reportDuplicateIds(entry.factRequirements, ['evidencePaths', index, 'factRequirements'], context);
      if (entry.source === 'answer' && entry.factRequirements.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['evidencePaths', index, 'factRequirements'],
          message: 'answer evidence requires deterministic fact requirements',
        });
      }
      if (entry.source === 'answer' && entry.referenceAnswerPoints.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['evidencePaths', index, 'referenceAnswerPoints'],
          message: 'answer evidence requires node-specific reference answer points',
        });
      }
    });
    value.tutoring.forEach((entry, index) => {
      const answerEvidence = value.evidencePaths.find((evidence) =>
        evidence.nodeId === entry.nodeId && evidence.source === 'answer');
      const antiLeakFacts = answerEvidence?.factRequirements
        .flatMap((requirement) => requirement.acceptedValues) ?? [];
      if (antiLeakFacts.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['tutoring', index, 'nodeId'],
          message: `tutorable node ${entry.nodeId} requires a non-empty deterministic anti-leak fact set`,
        });
      }
    });
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
      if (entry.level === 1) {
        entry.fields.forEach((field, fieldIndex) => {
          if (!value.targetNodeIds.includes(field.nodeId)) {
            context.addIssue({
              code: 'custom',
              path: ['scaffold', index, 'fields', fieldIndex, 'nodeId'],
              message: `scaffold field targets non-case node ${field.nodeId}`,
            });
          }
        });
      }
    });
    for (const expectedLevel of [1, 2, 3]) {
      if (!levels.has(expectedLevel)) {
        context.addIssue({
          code: 'custom',
          path: ['scaffold'],
          message: `missing scaffold level ${expectedLevel}`,
        });
      }
    }
  });

export const scaffoldPolicySchema = z
  .object({
    version: versionSchema,
    levels: z
      .array(
        z
          .object({
            level: z.number().int().min(1).max(3),
            label: z.string().trim().min(1),
            promptCount: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .length(3),
    promotion: z
      .object({
        consecutiveHits: z.number().int().positive(),
        eligibleOutcomes: z.array(z.enum(['hit', 'hit-with-help'])).min(1),
      })
      .strict(),
    demotion: z
      .object({
        consecutiveMisses: z.number().int().positive(),
        levels: z.number().int().positive(),
      })
      .strict(),
    assistance: z
      .object({
        correctOutcome: z.enum(['hit', 'hit-with-help']),
        countsForPromotion: z.boolean(),
      })
      .strict(),
    extraction: z
      .object({
        retryCount: z.literal(1),
        temperature: z.literal(0.1),
        maximumAnswerCharacters: z.number().int().positive().max(10_000),
        factValueAliases: z.record(
          z.string().trim().min(1),
          z.array(z.string().trim().min(1)).min(1),
        ),
        citation: z
          .object({
            maxEditDistanceRatio: z.number().min(0).max(1),
            normalizationCandidateMaxEditDistanceRatio: z.number().min(0).max(1),
            commonTypos: z.record(z.string().min(1), z.string().min(1)),
          })
          .strict(),
      })
      .strict(),
    socratic: z
      .object({
        maxRounds: z.number().int().min(1).max(3),
        correctedOutcome: z.enum(['hit', 'hit-with-help']),
        timeoutMs: z.number().int().positive().max(60_000),
        retryCount: z.literal(1),
        forceAdvanceAfterMs: z.number().int().positive().max(120_000),
        answerOverlapThreshold: z.number().min(0).max(1),
        minimumSharedBigrams: z.number().int().positive(),
        fallback: z
          .object({
            probe: z.string().trim().min(1),
            hint: z.string().trim().min(1),
            check: z.string().trim().min(1),
            closing: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
    passing: z
      .object({
        minimumRatio: z.number().min(0).max(1),
        requireNoCoreMiss: z.boolean(),
      })
      .strict(),
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
    if (
      value.extraction.citation.normalizationCandidateMaxEditDistanceRatio
      <= value.extraction.citation.maxEditDistanceRatio
    ) {
      context.addIssue({
        code: 'custom',
        path: ['extraction', 'citation', 'normalizationCandidateMaxEditDistanceRatio'],
        message: 'must exceed maxEditDistanceRatio',
      });
    }
    if (
      value.socratic.forceAdvanceAfterMs
      < value.socratic.timeoutMs * (value.socratic.retryCount + 1)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['socratic', 'forceAdvanceAfterMs'],
        message: 'must cover every configured timeout attempt',
      });
    }
  });

export type FunctionalRole = z.infer<typeof functionalRoleSchema>;
export type KnowledgeModelConfig = z.infer<typeof knowledgeModelSchema>;
export type RubricsConfig = z.infer<typeof rubricsSchema>;
export type PretestConfig = z.infer<typeof pretestSchema>;
export type CaseConfig = z.infer<typeof caseSchema>;
export type ScaffoldPolicyConfig = z.infer<typeof scaffoldPolicySchema>;

export interface LoadedConfig {
  configVersion: string;
  runtimeVersions: {
    cases: Record<string, string>;
    grammar: string;
    engines: {
      rubric: string;
      topology: string;
      equation: string;
    };
  };
  knowledgeModel: KnowledgeModelConfig;
  rubrics: RubricsConfig;
  pretest: PretestConfig;
  cases: CaseConfig[];
  scaffoldPolicy: ScaffoldPolicyConfig;
}
