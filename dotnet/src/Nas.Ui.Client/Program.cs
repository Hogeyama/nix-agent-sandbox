using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Nas.Ui.Client;
using Nas.Ui.Client.Services;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

var baseAddress = new Uri(builder.HostEnvironment.BaseAddress);
builder.Services.AddScoped(sp => new HttpClient { BaseAddress = baseAddress });
builder.Services.AddScoped(sp => new NasApiService(new HttpClient { BaseAddress = baseAddress }));
builder.Services.AddScoped(sp => new SseService(new HttpClient { BaseAddress = baseAddress, Timeout = System.Threading.Timeout.InfiniteTimeSpan }));

await builder.Build().RunAsync();
