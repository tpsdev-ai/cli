// cli#568 green fixture: the same module-object patch through the patchShared
// helper, which saves the original and restores it in a top-level afterAll. The
// guard must report nothing for this file.
import { patchShared } from "../../helpers/patch-shared.js";
import { target } from "./direct-module-target.js";

patchShared(target, "method", () => "mock");
