// Test fixture for nasCli_test.js: prints the args it received past its own
// path, so a test can assert on exactly what a spawned "nas" would have seen.
process.stdout.write(JSON.stringify(process.argv.slice(2)));
