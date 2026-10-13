import { target } from "./direct-module-target.js";
function outer() {
  for (var alias = target; false;) {}
  alias.method = () => "changed";
}
outer();
