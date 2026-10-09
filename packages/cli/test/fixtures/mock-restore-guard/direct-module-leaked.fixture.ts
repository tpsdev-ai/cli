// cli#568 red fixture: a direct assignment to a property of an imported module
// object, outside the patchShared helper. The guard must report
// direct-assignment-needs-restore. Not named *.test.ts, so no suite discovers it.
import { target } from "./direct-module-target.js";

target.method = () => "mock";
