using System.Text.Json;
using aplusdownloader.Models;
using Microsoft.JSInterop;

namespace aplusdownloader.Services;

public sealed class BrowserBookStore : IAsyncDisposable
{
    private readonly Lazy<Task<IJSObjectReference>> _moduleTask;
    private readonly IJSRuntime _jsRuntime;

    public BrowserBookStore(IJSRuntime jsRuntime)
    {
        _jsRuntime = jsRuntime;
        _moduleTask = new(() => _jsRuntime.InvokeAsync<IJSObjectReference>(
            "import",
            "./js/book-downloader.js").AsTask());
    }

    public async Task<int> DiscoverPageCountAsync(string bookId, CancellationToken cancellationToken = default)
    {
        var module = await _moduleTask.Value;
        return await module.InvokeAsync<int>("discoverPageCount", cancellationToken, bookId, 2000);
    }

    public async Task<DownloadResult> DownloadPageAsync(
        string bookId,
        int page,
        CancellationToken cancellationToken = default)
    {
        var module = await _moduleTask.Value;
        return await module.InvokeAsync<DownloadResult>(
            "downloadPage",
            cancellationToken,
            bookId,
            page);
    }

    public async Task<IReadOnlyList<StoredPage>> GetPagesAsync(
        string bookId,
        CancellationToken cancellationToken = default)
    {
        var module = await _moduleTask.Value;
        var result = await module.InvokeAsync<StoredPage[]>(
            "getStoredPages",
            cancellationToken,
            bookId);

        return result ?? [];
    }

    public async Task<string> CreatePageObjectUrlAsync(
        string bookId,
        int page,
        CancellationToken cancellationToken = default)
    {
        var module = await _moduleTask.Value;
        return await module.InvokeAsync<string>(
            "createPageObjectUrl",
            cancellationToken,
            bookId,
            page);
    }

    public async Task<bool> HasPageAsync(
        string bookId,
        int page,
        CancellationToken cancellationToken = default)
    {
        var module = await _moduleTask.Value;
        return await module.InvokeAsync<bool>(
            "hasPage",
            cancellationToken,
            bookId,
            page);
    }

    public async Task ClearBookAsync(
        string bookId,
        CancellationToken cancellationToken = default)
    {
        var module = await _moduleTask.Value;
        await module.InvokeVoidAsync("clearBook", cancellationToken, bookId);
    }

    public async Task ExportPdfAsync(
        string bookId,
        string fileName,
        CancellationToken cancellationToken = default)
    {
        var module = await _moduleTask.Value;
        await module.InvokeVoidAsync(
            "exportPdf",
            cancellationToken,
            bookId,
            fileName);
    }

    public async Task OpenAuthenticationAsync(
        string viewerUrl,
        CancellationToken cancellationToken = default)
    {
        var module = await _moduleTask.Value;
        await module.InvokeVoidAsync(
            "openAuthentication",
            cancellationToken,
            viewerUrl);
    }

    public async ValueTask DisposeAsync()
    {
        if (!_moduleTask.IsValueCreated)
        {
            return;
        }

        try
        {
            var module = await _moduleTask.Value;
            await module.DisposeAsync();
        }
        catch (JSDisconnectedException)
        {
        }
    }
}

public sealed record DownloadResult(
    bool Success,
    int Page,
    int Width,
    int Height,
    string? Error)
{
    public static DownloadResult Failed(int page, string error) =>
        new(false, page, 0, 0, error);
}
