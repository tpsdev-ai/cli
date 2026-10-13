import { target } from "./direct-module-target.js";
function outer() {
  for (var alias = target; false;) {}
  function inner() { alias.method = () => "changed"; }
  inner();
}
outer();
