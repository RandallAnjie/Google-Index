// POST /<n>:id2path → plain-text path for the given Drive ID.
// Used by the search results page to resolve a hit's parent path so
// the breadcrumb knows where the file lives.

export async function handleId2Path(request, gd) {
  const option = {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
  };
  const form = await request.formData();
  const path = await gd.findPathById(form.get("id"));
  return new Response(path || "", option);
}
