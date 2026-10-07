namespace aplusdownloader.Services;

public static class BookUrlParser
{
    public static bool TryGetBookId(string? input, out string bookId)
    {
        bookId = string.Empty;

        if (string.IsNullOrWhiteSpace(input))
        {
            return false;
        }

        if (!Uri.TryCreate(input.Trim(), UriKind.Absolute, out var uri))
        {
            return false;
        }

        var segments = uri.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var viewerIndex = Array.FindIndex(
            segments,
            segment => string.Equals(segment, "viewer", StringComparison.OrdinalIgnoreCase));

        if (viewerIndex < 0 || viewerIndex + 1 >= segments.Length)
        {
            return false;
        }

        var candidate = segments[viewerIndex + 1];

        if (candidate.Length < 10 || candidate.Length > 32)
        {
            return false;
        }

        if (candidate.Any(char.IsWhiteSpace))
        {
            return false;
        }

        bookId = candidate;
        return true;
    }

    public static string GetViewerUrl(string bookId) =>
        $"https://biblioteca-a.read.garden/viewer/{Uri.EscapeDataString(bookId)}/capa";

    public static string GetThumbnailUrl(string bookId, int page) =>
        $"https://grupo-a-cdn.read.garden/books/{Uri.EscapeDataString(bookId)}/thumb/{page}.jpg";

    public static string GetPageUrl(string bookId, int page) =>
        $"https://grupo-a-cdn.read.garden/books/{Uri.EscapeDataString(bookId)}/{page}.jpg";
}
