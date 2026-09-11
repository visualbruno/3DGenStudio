// The Editor assembly lets its own test assembly see internals.
//
// WITHOUT THIS THERE ARE NO TESTS. An asmdef is a separate C# assembly, so
// `internal` does not reach across it - the test project sees only the public
// surface, which is VfxBundleImporter.Import and nothing else. Testing the rate
// gate through a whole bundle import would mean shipping fixture files and
// would still not say WHICH part was wrong when it failed.
//
// The alternative - making BuildRateGate public - would put a helper nobody
// outside this package should call into the package's API, where changing it
// later becomes a breaking change.
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("GenStudio3D.VfxImport.Tests")]
