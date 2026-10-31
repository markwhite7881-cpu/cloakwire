package app.cloakwire.client.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DiagnosticNetworkChoiceTest {
    @Test fun activePhysicalNetworkWinsOverEnumerationOrder() {
        assertEquals("wifi", diagnosticNetworkChoice("wifi", listOf("cellular", "wifi")))
        assertEquals("cellular", diagnosticNetworkChoice("cellular", listOf("wifi", "cellular")))
    }
    @Test fun vpnDefaultDoesNotAuthorizeAnArbitraryPhysicalFallback() {
        assertNull(diagnosticNetworkChoice("vpn", listOf("wifi", "cellular")))
        assertNull(diagnosticNetworkChoice(null, listOf("wifi", "cellular")))
    }
    @Test fun onlyOnePhysicalCandidateIsUnambiguous() {
        assertEquals("wifi", diagnosticNetworkChoice("vpn", listOf("wifi")))
        assertNull(diagnosticNetworkChoice("vpn", emptyList<String>()))
    }
}
