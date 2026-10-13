const { KEY: value, nested: { child } } = process.env;
value.method = () => "changed";
child.method = () => "changed";
