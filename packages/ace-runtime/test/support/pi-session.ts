import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** A real Pi session backed by a scripted in-process provider (no network, no credentials needed). */
export interface TestPiSession {
	readonly session: AgentSession;
	/** JSON of every request context the model received, in call order. */
	readonly requests: string[];
	/** Queue the assistant reply for the next model call. */
	reply(text: string): void;
	dispose(): Promise<void>;
}

function inMemoryCredentials(providerId: string, key: string): CredentialStore {
	const credentials = new Map<string, Credential>([[providerId, { type: "api_key", key }]]);
	return {
		async read(id) {
			return credentials.get(id);
		},
		async list(): Promise<readonly CredentialInfo[]> {
			return [...credentials.keys()].map((id) => ({ providerId: id, type: "api_key" as const }));
		},
		async modify(id, fn) {
			const next = await fn(credentials.get(id));
			if (next) credentials.set(id, next);
			return next;
		},
		async delete(id) {
			credentials.delete(id);
		},
	};
}

/** Build a Pi session whose model is a faux provider, isolated from user settings and project resources. */
export async function createTestPiSession(): Promise<TestPiSession> {
	const dir = mkdtempSync(join(tmpdir(), "ace-pi-"));
	const faux = registerFauxProvider();
	const model = faux.getModel();

	const modelRuntime = await ModelRuntime.create({
		credentials: inMemoryCredentials(model.provider, "faux-key"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});

	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime,
		model,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		noTools: "all",
	});

	const requests: string[] = [];
	return {
		session,
		requests,
		reply(text: string) {
			faux.appendResponses([
				(context: TranscriptContext) => {
					requests.push(JSON.stringify(context));
					return fauxAssistantMessage(text);
				},
			]);
		},
		async dispose() {
			session.dispose();
			faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
