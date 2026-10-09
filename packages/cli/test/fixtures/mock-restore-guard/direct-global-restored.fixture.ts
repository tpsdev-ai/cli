// cli#568 green fixture: the same global patch through the patchShared helper,
// which saves the original and restores it in a top-level afterAll. The guard
// must report nothing for this file.
import { patchShared } from "../../helpers/patch-shared.js";

patchShared(globalThis, "__tpsGuardProbe", () => "mock");
