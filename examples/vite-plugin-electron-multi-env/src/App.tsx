import { useEffect, useState } from "react"
import { getVersion } from "../electron/custom"

export default function App() {
	const [version, setVersion] = useState("")
	const [error, setError] = useState("")

	useEffect(() => {
		getVersion({ prefix: "v" })
			.then(setVersion)
			.catch((error: unknown) => {
				setError(error instanceof Error ? error.message : String(error))
			})

	}, [])

	return (
		<main>
			<h1>electron-ipc-invoke</h1>
			<p>Application version: {version || "loading..."}</p>
			{error && <p role="alert">{error}</p>}
		</main>
	)
}
