import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "@/features/shared/config/queryPatterns";
import { skillService } from "../services/skillService";

export const skillKeys = {
	all: ["skills"] as const,
	lists: () => [...skillKeys.all, "list"] as const,
	byProject: (projectId: string) => ["projects", projectId, "skills"] as const,
	projectSystems: (projectId: string) => ["projects", projectId, "systems"] as const,
};

export function useProjectSkills(projectId: string | undefined) {
	return useQuery({
		queryKey: projectId ? skillKeys.byProject(projectId) : DISABLED_QUERY_KEY,
		queryFn: () => (projectId ? skillService.getProjectSkills(projectId) : Promise.reject("No project ID")),
		enabled: !!projectId,
		staleTime: STALE_TIMES.normal,
	});
}

export function useProjectSystems(projectId: string | undefined) {
	return useQuery({
		queryKey: projectId ? skillKeys.projectSystems(projectId) : DISABLED_QUERY_KEY,
		queryFn: () => (projectId ? skillService.getProjectSystems(projectId) : Promise.reject("No project ID")),
		enabled: !!projectId,
		staleTime: STALE_TIMES.normal,
	});
}

export function useAllSkills() {
	return useQuery({
		queryKey: skillKeys.lists(),
		queryFn: () => skillService.getAllSkills(),
		staleTime: STALE_TIMES.normal,
	});
}

export function useInstallSkill() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			projectId,
			skillId,
			systemIds,
		}: {
			projectId: string;
			skillId: string;
			systemIds: string[];
		}) => skillService.installSkill(projectId, skillId, systemIds),
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({ queryKey: skillKeys.byProject(variables.projectId) });
		},
	});
}

export function useRemoveSkill() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			projectId,
			skillId,
			systemIds,
		}: {
			projectId: string;
			skillId: string;
			systemIds: string[];
		}) => skillService.removeSkill(projectId, skillId, systemIds),
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({ queryKey: skillKeys.byProject(variables.projectId) });
		},
	});
}
