const DB_NAME = "aplusbookdownloader";
const DB_VERSION = 1;
const STORE_NAME = "pages";

const objectUrls = new Map();

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const database = request.result;

            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, {
                    keyPath: "key"
                });

                store.createIndex("bookId", "bookId", { unique: false });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB error."));
    });
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    });
}

function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    });
}

function pageKey(bookId, page) {
    return bookId + ":" + page;
}

async function putPage(bookId, page, blob, width, height) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
        key: pageKey(bookId, page),
        bookId,
        page,
        blob,
        width,
        height
    });

    await transactionComplete(transaction);
    database.close();
}

async function getPage(bookId, page) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const result = await requestToPromise(
        transaction.objectStore(STORE_NAME).get(pageKey(bookId, page)));

    database.close();
    return result ?? null;
}

async function getStoredPages(bookId) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const index = transaction.objectStore(STORE_NAME).index("bookId");
    const records = await requestToPromise(index.getAll(bookId));

    database.close();

    return (records ?? [])
        .sort((left, right) => left.page - right.page)
        .map(record => ({
            page: record.page,
            width: record.width,
            height: record.height
        }));
}

async function hasPage(bookId, page) {
    return (await getPage(bookId, page)) !== null;
}

async function clearBook(bookId) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index("bookId");
    const keys = await requestToPromise(index.getAllKeys(bookId));

    for (const key of keys ?? []) {
        store.delete(key);
    }

    await transactionComplete(transaction);
    database.close();

    for (const [key, url] of objectUrls.entries()) {
        if (key.startsWith(bookId + ":")) {
            URL.revokeObjectURL(url);
            objectUrls.delete(key);
        }
    }
}

function loadImage(url, crossOrigin = undefined) {
    return new Promise((resolve, reject) => {
        const image = new Image();

        if (crossOrigin) {
            image.crossOrigin = crossOrigin;
        }

        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Image could not be loaded."));
        image.src = url;
    });
}

async function imageExists(url) {
    try {
        const image = await loadImage(url);
        return image.naturalWidth > 0 && image.naturalHeight > 0;
    } catch {
        return false;
    }
}

async function discoverPageCount(bookId, maximumPages = 2000) {
    const baseUrl =
        "https://grupo-a-cdn.read.garden/books/" +
        encodeURIComponent(bookId) +
        "/thumb/";

    if (!(await imageExists(baseUrl + "1.jpg"))) {
        return 0;
    }

    let lower = 1;
    let upper = 2;

    while (upper <= maximumPages && await imageExists(baseUrl + upper + ".jpg")) {
        lower = upper;
        upper *= 2;
    }

    upper = Math.min(upper, maximumPages + 1);

    while (lower + 1 < upper) {
        const middle = Math.floor((lower + upper) / 2);

        if (await imageExists(baseUrl + middle + ".jpg")) {
            lower = middle;
        } else {
            upper = middle;
        }
    }

    return lower;
}

async function fetchPageBlob(bookId, page) {
    const url =
        "https://grupo-a-cdn.read.garden/books/" +
        encodeURIComponent(bookId) +
        "/" +
        page +
        ".jpg";

    try {
        const response = await fetch(url, {
            credentials: "include",
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(
                "HTTP " + response.status + " ao acessar a imagem protegida.");
        }

        const blob = await response.blob();
        return await readImageBlob(blob);
    } catch (fetchError) {
        // A cross-origin <img> can load without CORS, but reading it back through
        // canvas still requires the CDN to opt in to CORS. This fallback is useful
        // for deployments where fetch() is rejected but the image is CORS-enabled.
        try {
            const image = await loadImage(url, "use-credentials");
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;

            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0);

            const blob = await new Promise((resolve, reject) => {
                canvas.toBlob(
                    result => result ? resolve(result) : reject(new Error("Canvas export failed.")),
                    "image/jpeg",
                    0.95);
            });

            return {
                blob,
                width: image.naturalWidth,
                height: image.naturalHeight
            };
        } catch (imageError) {
            throw new Error(
                "A imagem protegida não pôde ser lida pelo navegador. " +
                "Isso normalmente indica ausência de CORS no CDN para o domínio do downloader. " +
                "Fetch: " + fetchError.message +
                ". Imagem: " + imageError.message);
        }
    }
}

async function readImageBlob(blob) {
    const bitmap = await createImageBitmap(blob);

    const result = {
        blob,
        width: bitmap.width,
        height: bitmap.height
    };

    bitmap.close();
    return result;
}

async function downloadPage(bookId, page) {
    try {
        const existing = await getPage(bookId, page);

        if (existing) {
            return {
                success: true,
                page,
                width: existing.width,
                height: existing.height,
                error: null
            };
        }

        const image = await fetchPageBlob(bookId, page);
        await putPage(bookId, page, image.blob, image.width, image.height);

        return {
            success: true,
            page,
            width: image.width,
            height: image.height,
            error: null
        };
    } catch (error) {
        return {
            success: false,
            page,
            width: 0,
            height: 0,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

async function createPageObjectUrl(bookId, page) {
    const key = pageKey(bookId, page);

    if (objectUrls.has(key)) {
        return objectUrls.get(key);
    }

    const record = await getPage(bookId, page);

    if (!record) {
        return "";
    }

    const url = URL.createObjectURL(record.blob);
    objectUrls.set(key, url);
    return url;
}

async function openAuthentication(viewerUrl) {
    const loginUrl =
        "https://biblioteca-a.read.garden/login?returnUrl=" +
        encodeURIComponent(viewerUrl);

    const popup = window.open(
        loginUrl,
        "aplusbookdownloader-library-login",
        "popup,width=1100,height=800,resizable=yes,scrollbars=yes");

    if (!popup) {
        window.open(loginUrl, "_blank", "noopener,noreferrer");
    }
}

function writeAscii(target, offset, value) {
    const bytes = new TextEncoder().encode(value);

    target.set(bytes, offset);
    return offset + bytes.length;
}

function concatUint8Arrays(parts) {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const result = new Uint8Array(length);

    let offset = 0;

    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }

    return result;
}

async function buildPdf(bookId) {
    const records = await getStoredPages(bookId);

    if (!records.length) {
        throw new Error("Nenhuma página armazenada.");
    }

    const objects = [];
    const pageObjectNumbers = [];
    const contentObjectNumbers = [];
    const imageObjectNumbers = [];

    let nextObjectNumber = 3;

    for (const record of records) {
        pageObjectNumbers.push(nextObjectNumber++);
        contentObjectNumbers.push(nextObjectNumber++);
        imageObjectNumbers.push(nextObjectNumber++);
    }

    const pagesObjectNumber = 2;
    const catalogObjectNumber = 1;

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const stored = await getPage(bookId, record.page);
        const imageBytes = new Uint8Array(await stored.blob.arrayBuffer());

        const imageObject = [
            imageObjectNumbers[i] +
            " 0 obj\n" +
            "<< /Type /XObject /Subtype /Image /Width " +
            record.width +
            " /Height " +
            record.height +
            " /ColorSpace /DeviceRGB /BitsPerComponent 8 " +
            "/Filter /DCTDecode /Length " +
            imageBytes.length +
            " >>\nstream\n"
        ];

        const imageHeader = new TextEncoder().encode(imageObject[0]);
        const imageFooter = new TextEncoder().encode("\nendstream\nendobj\n");
        objects.push(concatUint8Arrays([imageHeader, imageBytes, imageFooter]));

        const pageWidth = 595;
        const pageHeight = 842;
        const scale = Math.min(
            pageWidth / record.width,
            pageHeight / record.height);

        const imageWidth = record.width * scale;
        const imageHeight = record.height * scale;
        const x = (pageWidth - imageWidth) / 2;
        const y = (pageHeight - imageHeight) / 2;

        const content = [
            "q\n",
            imageWidth.toFixed(4),
            " 0 0 ",
            imageHeight.toFixed(4),
            " ",
            x.toFixed(4),
            " ",
            y.toFixed(4),
            " cm\n",
            "/Im",
            i + 1,
            " Do\nQ\n"
        ].join("");

        const contentBytes = new TextEncoder().encode(content);
        const contentObject = new TextEncoder().encode(
            contentObjectNumbers[i] +
            " 0 obj\n<< /Length " +
            contentBytes.length +
            " >>\nstream\n" +
            content +
            "endstream\nendobj\n");

        objects.push(contentObject);
    }

    const kids = pageObjectNumbers.map(number => number + " 0 R").join(" ");

    const pagesObject = new TextEncoder().encode(
        pagesObjectNumber +
        " 0 obj\n" +
        "<< /Type /Pages /Kids [" +
        kids +
        "] /Count " +
        records.length +
        " >>\nendobj\n");

    objects.unshift(pagesObject);

    for (let i = 0; i < records.length; i++) {
        const pageObject = new TextEncoder().encode(
            pageObjectNumbers[i] +
            " 0 obj\n" +
            "<< /Type /Page /Parent " +
            pagesObjectNumber +
            " 0 R /MediaBox [0 0 595 842] " +
            "/Resources << /XObject << /Im" +
            (i + 1) +
            " " +
            imageObjectNumbers[i] +
            " 0 R >> >> " +
            "/Contents " +
            contentObjectNumbers[i] +
            " 0 R >>\nendobj\n");

        objects.splice(1 + i * 3, 0, pageObject);
    }

    const catalogObject = new TextEncoder().encode(
        catalogObjectNumber +
        " 0 obj\n" +
        "<< /Type /Catalog /Pages " +
        pagesObjectNumber +
        " 0 R >>\nendobj\n");

    objects.unshift(catalogObject);

    const header = new Uint8Array([
        0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x37, 0x0A,
        0x25, 0xFF, 0xFF, 0xFF, 0xFF, 0x0A
    ]);

    const offsets = [0];
    let position = header.length;
    const parts = [header];

    for (const object of objects) {
        offsets.push(position);
        parts.push(object);
        position += object.length;
    }

    const xrefOffset = position;
    const xrefLines = [
        "xref\n",
        "0 ",
        objects.length + 1,
        "\n",
        "0000000000 65535 f \n"
    ];

    for (let i = 1; i < offsets.length; i++) {
        xrefLines.push(
            String(offsets[i]).padStart(10, "0") +
            " 00000 n \n");
    }

    xrefLines.push(
        "trailer\n" +
        "<< /Size " +
        (objects.length + 1) +
        " /Root " +
        catalogObjectNumber +
        " 0 R >>\n" +
        "startxref\n" +
        xrefOffset +
        "\n%%EOF\n");

    parts.push(new TextEncoder().encode(xrefLines.join("")));

    return new Blob([concatUint8Arrays(parts)], {
        type: "application/pdf"
    });
}

async function exportPdf(bookId, fileName) {
    const pdf = await buildPdf(bookId);
    const url = URL.createObjectURL(pdf);

    try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName || "ebook.pdf";
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
}

export {
    discoverPageCount,
    downloadPage,
    getStoredPages,
    createPageObjectUrl,
    hasPage,
    clearBook,
    exportPdf,
    openAuthentication
};
