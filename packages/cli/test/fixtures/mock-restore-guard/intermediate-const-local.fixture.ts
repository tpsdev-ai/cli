// cli#577 green fixture: a member assigned on a local const whose root resolves
// to a local binding. Not named *.test.ts, so no suite discovers it.
function factory() {
  return { name: "" };
}
const u = factory();
u.name = "x";
