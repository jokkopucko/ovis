import type { DialogReader } from "./registry.ts";
import { readers as claude } from "./claude.ts";
import { readers as codex } from "./codex.ts";
import { readers as omp } from "./omp.ts";
import { readers as omo } from "./omo.ts";
import { readers as pi } from "./pi.ts";
import { readers as piQuestionnaire } from "./pi-questionnaire.ts";
import { readers as piAsk } from "./pi-ask.ts";
import { readers as piAskUser } from "./pi-ask-user.ts";
import { readers as hermes } from "./hermes.ts";
import { readers as opencode } from "./opencode.ts";
import { readers as agy } from "./agy.ts";
import { readers as cmd } from "./cmd.ts";
import { readers as letta } from "./letta.ts";
import { readers as dsh } from "./dsh.ts";
import { readers as fallback } from "./fallback.ts";

export const readers: readonly DialogReader[] = [...claude, ...codex, ...omp, ...omo, ...pi, ...piQuestionnaire, ...piAsk, ...piAskUser, ...hermes, ...opencode, ...agy, ...cmd, ...letta, ...dsh, ...fallback];
