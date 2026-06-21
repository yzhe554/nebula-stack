import { z } from "zod";

const ec2ClusterSchema = z
  .object({
    capacity: z.literal("ec2"),
    instanceType: z.string().min(1),
    desiredCapacity: z.number().int().positive(),
    autoscaling: z
      .object({
        minCapacity: z.number().int().positive(),
        maxCapacity: z.number().int().positive(),
      })
      .strict()
      .refine((autoscaling) => autoscaling.maxCapacity >= autoscaling.minCapacity, {
        message: "maxCapacity must be greater than or equal to minCapacity",
        path: ["maxCapacity"],
      })
      .optional()
      .describe("Optional EC2 Auto Scaling Group capacity bounds for ECS-on-EC2."),
  })
  .strict();

const fargateClusterSchema = z
  .object({
    capacity: z.literal("fargate"),
  })
  .strict();

export const fargateTaskMemoryByCpu = new Map<number, readonly number[]>([
  [256, [512, 1024, 2048]],
  [512, [1024, 2048, 3072, 4096]],
  [1024, [2048, 3072, 4096, 5120, 6144, 7168, 8192]],
]);

export const ecsSchema = z
  .object({
    cluster: z.discriminatedUnion("capacity", [ec2ClusterSchema, fargateClusterSchema]),
    service: z
      .object({
        desiredCount: z.number().int().positive(),
        containerPort: z.number().int().min(1).max(65535),
        autoscaling: z
          .object({
            minCount: z.number().int().positive(),
            maxCount: z.number().int().positive(),
            targetCpuUtilization: z.number().int().min(1).max(100).optional(),
            targetMemoryUtilization: z.number().int().min(1).max(100).optional(),
          })
          .strict()
          .refine((autoscaling) => autoscaling.maxCount >= autoscaling.minCount, {
            message: "maxCount must be greater than or equal to minCount",
            path: ["maxCount"],
          })
          .refine(
            (autoscaling) =>
              autoscaling.targetCpuUtilization !== undefined ||
              autoscaling.targetMemoryUtilization !== undefined,
            {
              message:
                "At least one of targetCpuUtilization or targetMemoryUtilization is required",
            },
          )
          .optional()
          .describe("Optional ECS service autoscaling for task count."),
      })
      .strict(),
    task: z
      .object({
        cpu: z
          .number()
          .int()
          .positive()
          .max(1024)
          .describe(
            "ECS task CPU units. 1024 CPU units = 1 vCPU. Keep Node.js services at or below 1024 unless the platform policy changes.",
          ),
        memoryMb: z
          .number()
          .int()
          .positive()
          .describe("ECS task memory in MiB, such as 512 or 1024."),
      })
      .strict(),
    image: z
      .object({
        repository: z.string().min(1),
        tag: z.string().min(1),
      })
      .strict(),
    healthCheck: z
      .object({
        path: z.string().min(1).startsWith("/"),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.cluster.capacity !== "fargate") {
      return;
    }

    const allowedMemory = fargateTaskMemoryByCpu.get(config.task.cpu);
    if (!allowedMemory || !allowedMemory.includes(config.task.memoryMb)) {
      context.addIssue({
        code: "custom",
        message:
          allowedMemory === undefined
            ? `Fargate task.cpu ${config.task.cpu} is not supported. Supported cpu values: ${[
                ...fargateTaskMemoryByCpu.keys(),
              ].join(", ")}.`
            : `${config.task.memoryMb} is not valid for Fargate task.cpu ${config.task.cpu}. Supported memoryMb values: ${allowedMemory.join(", ")}.`,
        path: ["task", "memoryMb"],
      });
    }
  });
