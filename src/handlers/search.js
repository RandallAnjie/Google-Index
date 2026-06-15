// POST /<n>:search → JSON search payload.

export async function handleSearch(request, gd) {
  const option = {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    },
  };
  const form = await request.formData();
  const search_result = await gd.search(
    form.get("q") || "",
    form.get("page_token"),
    Number(form.get("page_index")),
  );
  return new Response(JSON.stringify(search_result), option);
}
