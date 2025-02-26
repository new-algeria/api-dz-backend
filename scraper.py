import os
import sys
import json
import time
import random
import paramiko
import logging
from argparse import ArgumentParser
from urllib.parse import urlparse
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.wait import WebDriverWait
from selenium.webdriver import ActionChains
from selenium.webdriver.common.keys import Keys

# Configure logging (unchanged)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('scraper.log'),
        logging.StreamHandler()
    ]
)
logging.info('Starting the scraper...')

class SFTPManager:
    def __init__(self, uri):
        parsed = urlparse(uri)
        self.host = parsed.hostname
        self.port = parsed.port or 22
        self.user = parsed.username
        self.pwd = parsed.password
        self.base_path = parsed.path  # Preserve leading slash

        self.transport = paramiko.Transport((self.host, self.port))
        self.transport.connect(username=self.user, password=self.pwd)
        self.sftp = paramiko.SFTPClient.from_transport(self.transport)

    def get_json(self, filename):
        """Secure JSON file download with validation"""
        # local_path = str(Path(filename).name)
        # remote_path = os.path.join(self.base_path, filename)
        local_path = Path(filename).name
        remote_path = Path(self.base_path) / filename

        try:
            self.sftp.get(str(remote_path), str(local_path))
            with open(local_path, 'r') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError) as e:
            print(f"Error loading {filename}: {str(e)}")
            raise
        except Exception as e:
            self.sftp.close()
            self.transport.close()
            raise

    def put_json(self, data, filename):
        """Atomic file update with temp file"""
        temp_file = f"{filename}.tmp"
        with open(temp_file, 'w') as f:
            json.dump(data, f, indent=2)
        
        try:
            self.sftp.put(temp_file, str(self.base_path / filename))
            Path(temp_file).unlink()
        finally:
            if Path(temp_file).exists():
                Path(temp_file).unlink()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.sftp.close()
        self.transport.close()


def human_like_delay(min_t=1, max_t=3):
    time.sleep(random.uniform(min_t, max_t))

def human_type(element, text, delay=(0.1, 0.5)):
    """Simulate human typing with random delays between keystrokes"""
    ActionChains(element._parent).move_to_element(element).click().perform()
    for char in text:
        element.send_keys(char)
        time.sleep(random.uniform(*delay))

def solve_cloudflare(driver):
    try:
        if "cloudflare" in driver.page_source.lower():
            driver.switch_to.frame(driver.find_element(By.XPATH, "//iframe[contains(@title, 'Challenge')]"))
            verify_btn = WebDriverWait(driver, 15).until(
                EC.element_to_be_clickable((By.XPATH, "//span[@class='mark']"))
            )
            ActionChains(driver).move_to_element(verify_btn).pause(1).click().perform()
            driver.switch_to.default_content()
            human_like_delay(3, 5)
            return True
    except Exception:
        return False

def perform_login(driver, email, password):
    """Handle login flow with human-like interactions"""
    driver.get("https://rapidapi.com/studio")
    
    # Wait for login page to load
    WebDriverWait(driver, 10).until(
        EC.presence_of_element_located((By.ID, "login-form_email")))
    
    # Fill email
    email_field = driver.find_element(By.ID, "login-form_email")
    human_type(email_field, email)
    human_like_delay(1, 2)
    
    # Fill password
    password_field = driver.find_element(By.ID, "login-form_password")
    human_type(password_field, password)
    human_like_delay(1, 2)
    
    # Click submit
    submit_btn = WebDriverWait(driver, 10).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, "button[type='submit']")))
    ActionChains(driver).move_to_element(submit_btn).pause(1).click().perform()
    human_like_delay(2, 4)
    
    # Wait for login to complete
    WebDriverWait(driver, 20).until(
        EC.url_contains("studio"))
    human_like_delay(2, 4)  # Additional post-login delay

def process_object(driver, obj, jwt_token):
    """Enhanced processing with robust element handling"""
    # Navigate to target page with extended wait
    driver.get("https://rapidapi.com/studio/api_22dd3f3e-f11a-494c-a080-228eb6f67e8c/client/4b16491c-11b6-468c-b841-03c78261b8cd")
    WebDriverWait(driver, 20).until(
        EC.presence_of_element_located((By.TAG_NAME, 'body'))
    )
    for attempt in range(3):
        try:
            
            # Define the shared shadow DOM and iframe logic as a separate string
            SHARED_SHADOW_DOM_IFRAME_LOGIC = """
                function searchInShadowDOM(element) {
                    if (element.shadowRoot) {
                        console.log("Element has shadowRoot, searching within it");
                        const result = findTargetInContext(element.shadowRoot);
                        if (result) return result;
                        for (const child of element.shadowRoot.children) {
                            const result = searchInShadowDOM(child);
                            if (result) return result;
                        }
                    }
                    for (const child of element.children) {
                        const result = searchInShadowDOM(child);
                        if (result) return result;
                    }
                    return null;
                }

                function searchInIframes() {
                    const iframes = document.querySelectorAll('iframe');
                    for (const iframe of iframes) {
                        try {
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                            console.log("Searching in iframe:", iframe);
                            const result = findTargetInContext(iframeDoc) || searchInShadowDOM(iframeDoc.body);
                            if (result) return result;
                        } catch(e) {
                            console.log("Error accessing iframe:", e);
                        }
                    }
                    return null;
                }
            """
            
            # --- Click 'Add' Button with JS-based detection ---
            try:
                human_like_delay(10, 15)
                
                # Inject JavaScript to search (including shadow DOM) and click the add button
                js_script ="""
                console.log("Starting search for add button...");
                function findButtonInContext(context) {
                    const addSvg = context.querySelector('svg[aria-label="add"]');
                    if (addSvg) {
                        console.log("Found SVG with aria-label 'add'");
                        const addButton = addSvg.closest('button');
                        if (addButton) {
                            console.log("Found closest button for add SVG");
                            addButton.style.border = '3px solid #00ff00'; // Green border for success
                            return addButton;
                        }
                    }
                    
                    const tooltipButton = context.querySelector('button[aria-describedby^="tooltip-"]');
                    if (tooltipButton) {
                        console.log("Found tooltip button");
                        tooltipButton.style.border = '3px solid #ff0000'; // Red border for fallback
                        return tooltipButton;
                    }
                    console.log("No button found in current context");
                    return null;
                }

                %SHARED_SHADOW_DOM_IFRAME_LOGIC%

                //let button = findButtonInContext(document) || searchInShadowDOM(document.body);
                let button = false;
                
                if (!button) {
                    console.log("Button not found in document, now checking iframes");
                    const iframes = document.querySelectorAll('iframe');
                    for (const iframe of iframes) {
                        try {
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                            console.log("Searching in iframe:", iframe);
                            button = findButtonInContext(iframeDoc) || searchInShadowDOM(iframeDoc.body);
                            if (button) break;
                        } catch(e) {
                            console.log("Error accessing iframe:", e);
                        }
                    }
                }
                // Modify the button return section in your js_script:
                if (button) {
                    console.log("Button successfully found:", button);
                    // Add visual feedback
                    button.style.border = '3px solid #00ff00';
                    button.style.boxShadow = '0 0 10px rgba(0,255,0,0.5)';
                    button.click();
                    // Return success status instead of button element
                    return {
                        success: true,
                        message: "Button clicked successfully"
                    };
                }
                console.log("Add button not found after searching all contexts");
                return null;
                """.replace("%SHARED_SHADOW_DOM_IFRAME_LOGIC%", SHARED_SHADOW_DOM_IFRAME_LOGIC)
                
                result = driver.execute_script(js_script)
                driver.save_screenshot('button_visual_confirmation.png')
                if result and result.get('success'):
                    logging.info("Add button found and clicked via JS injection.")
                else:
                    raise Exception("Add button not found in injected JS script.")

            
            except Exception as e:
                logging.error(f"Add button error via JS injection: {str(e)}")
                driver.save_screenshot("error_add_button_js.png")
                raise

            # --- Endpoint Input JS Injection ---
            try:
                human_like_delay(1, 2)
                endpoint_js = """
                function setEndpointValue(targetElement, value) {
                    targetElement.focus();
                    targetElement.innerHTML = '';
                    
                    // For contenteditable elements
                    const range = document.createRange();
                    const selection = window.getSelection();
                    range.selectNodeContents(targetElement);
                    range.collapse(false);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    
                    const textNode = document.createTextNode(value);
                    targetElement.appendChild(textNode);
                    
                    // Trigger necessary events
                    const inputEvent = new Event('input', { bubbles: true, cancelable: true });
                    const changeEvent = new Event('change', { bubbles: true });
                    targetElement.dispatchEvent(inputEvent);
                    targetElement.dispatchEvent(changeEvent);
                }

                function searchShadowDOM(root) {
                    const allElements = root.querySelectorAll('*');
                    for (let el of allElements) {
                        if (el.shadowRoot) {
                            const result = searchShadowDOM(el.shadowRoot);
                            if (result) return result;
                        }
                    }
                    return null;
                }

                function searchFrames() {
                    // Try main document first
                    let editor = document.querySelector('div[contenteditable="true"]');
                    if (editor) return { element: editor, context: document };
                    
                    // Search shadow DOM
                    const shadowElement = searchShadowDOM(document.body);
                    if (shadowElement) {
                        editor = shadowElement.querySelector('div[contenteditable="true"]');
                        if (editor) return { element: editor, context: shadowElement };
                    }

                    // Check accessible iframes
                    const frames = document.querySelectorAll('iframe');
                    for (const frame of frames) {
                        try {
                            const frameDoc = frame.contentDocument || frame.contentWindow.document;
                            editor = frameDoc.querySelector('div[contenteditable="true"]');
                            if (editor) return { element: editor, context: frameDoc };
                            
                            // Search shadow DOM in iframe
                            const frameShadow = searchShadowDOM(frameDoc.body);
                            if (frameShadow) {
                                editor = frameShadow.querySelector('div[contenteditable="true"]');
                                if (editor) return { element: editor, context: frameShadow };
                            }
                        } catch(e) { continue; }
                    }
                    return null;
                }

                const result = searchFrames();
                if (result) {
                    setEndpointValue(result.element, '%URL%');
                    return {
                        success: true,
                        message: "endpoint filled successfully"
                    };
                }
                return null;
                """.replace('%URL%', f'https://api.dz.com/api/{obj["slug"]}')

                # Execute the full script
                success = driver.execute_script(endpoint_js)
                if result and result.get('success'):
                    logging.info("Endpoint input filled via JS injection")
                else:
                    raise Exception("Endpoint input not found")

            except Exception as e:
                logging.error(f"Endpoint JS error: {str(e)}")
                driver.save_screenshot("endpoint_error.png")
                raise

            # --- Description Button JS Injection ---
            try:
                desc_button_js = """
                function findDescButtonInContext(context) {
                    const xpath = "//button[.//div[contains(translate(text(), 'DESCRIPTION', 'description'), 'description')]]";
                    const result = document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    const button = result.singleNodeValue;
                    if (button) {
                        console.log("Found description button");
                        button.style.border = '3px solid #00ff00';
                        button.style.boxShadow = '0 0 10px rgba(0,255,0,0.5)';
                        return button;
                    }
                    return null;
                }

                %SHARED_SHADOW_DOM_IFRAME_LOGIC%

                //let descButton = findDescButtonInContext(document) || searchInShadowDOM(document.body);
                let descButton = false;

                if (!descButton) {
                    const iframes = document.querySelectorAll('iframe');
                    for (const iframe of iframes) {
                        try {
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                            descButton = findDescButtonInContext(iframeDoc) || searchInShadowDOM(iframeDoc.body);
                            if (descButton) break;
                        } catch(e) { console.log("Iframe error:", e); }
                    }
                }

                if (descButton) {
                    descButton.click();
                    return true;
                }
                return false;
                """.replace("%SHARED_SHADOW_DOM_IFRAME_LOGIC%", SHARED_SHADOW_DOM_IFRAME_LOGIC)

                driver.execute_script(desc_button_js)
                logging.info("Description button clicked via JS")
                human_like_delay(1, 2)

            except Exception as e:
                logging.error(f"Description button JS error: {str(e)}")
                raise

            # --- Title Input JS Injection ---
            try:
                title_js = """
                function setTitleValue(targetElement, value) {
                    targetElement.focus();
                    targetElement.value = '';
                    
                    // Set value directly for normal inputs
                    targetElement.value = '%TITLE%';
                    
                    // Trigger input events
                    const inputEvent = new Event('input', { bubbles: true, cancelable: true });
                    const changeEvent = new Event('change', { bubbles: true });
                    targetElement.dispatchEvent(inputEvent);
                    targetElement.dispatchEvent(changeEvent);
                    
                    // Special handling for React controlled components
                    const reactKey = Object.keys(targetElement).find(k => k.startsWith('__reactProps'));
                    if (reactKey) {
                        const reactHandler = targetElement[reactKey].onChange;
                        if (typeof reactHandler === 'function') {
                            reactHandler({ target: targetElement });
                        }
                    }
                }

                function searchShadowDOM(root) {
                    const allElements = root.querySelectorAll('*');
                    for (let el of allElements) {
                        if (el.shadowRoot) {
                            const result = searchShadowDOM(el.shadowRoot);
                            if (result) return result;
                        }
                        if (el.matches('.css-d4v849, input[type="text"][aria-label*="Title"], input.title-field')) {
                            return el;
                        }
                    }
                    return null;
                }

                function searchFrames() {
                    // Try main document first
                    let titleInput = document.querySelector('.css-d4v849, input[type="text"][aria-label*="Title"], input.title-field');
                    if (titleInput) return { element: titleInput, context: document };
                    
                    // Search shadow DOM
                    const shadowElement = searchShadowDOM(document.body);
                    if (shadowElement) {
                        titleInput = shadowElement.matches('input') ? shadowElement : shadowElement.querySelector('input');
                        if (titleInput) return { element: titleInput, context: shadowElement };
                    }

                    // Check accessible iframes
                    const frames = document.querySelectorAll('iframe');
                    for (const frame of frames) {
                        try {
                            const frameDoc = frame.contentDocument || frame.contentWindow.document;
                            titleInput = frameDoc.querySelector('.css-d4v849, input[type="text"][aria-label*="Title"], input.title-field');
                            if (titleInput) return { element: titleInput, context: frameDoc };
                            
                            // Search shadow DOM in iframe
                            const frameShadow = searchShadowDOM(frameDoc.body);
                            if (frameShadow) {
                                titleInput = frameShadow.matches('input') ? frameShadow : frameShadow.querySelector('input');
                                if (titleInput) return { element: titleInput, context: frameShadow };
                            }
                        } catch(e) { continue; }
                    }
                    return null;
                }

                const result = searchFrames();
                if (result) {
                    setTitleValue(result.element, '%TITLE%');
                    return {
                        success: true,
                        message: "title filled successfully",
                        element: result.element.tagName
                    };
                }
                return {
                    success: false,
                    message: "title input not found"
                };
                """.replace('%TITLE%', json.dumps(obj['title']['en'])[1:-1])

                print(f'{obj['title']['en']}')
                # Execute the full script
                result = driver.execute_script(title_js)
                if result and result['success']:
                    logging.info(f"Title input filled: {result['message']}")
                else:
                    raise Exception(f"Title input failed: {result.get('message', 'Unknown error') if result else 'No result'}")

            except Exception as e:
                logging.error(f"Title input JS error: {str(e)}")
                raise

            # --- Description Input JS Injection ---
            try:
                description_js = """
                function setDescriptionValue(targetElement, value) {
                    targetElement.focus();
                    targetElement.value = '';

                    // Set value directly for normal textareas
                    targetElement.value = '%DESCRIPTION%';

                    // Trigger input events
                    const inputEvent = new Event('input', { bubbles: true, cancelable: true });
                    const changeEvent = new Event('change', { bubbles: true });
                    targetElement.dispatchEvent(inputEvent);
                    targetElement.dispatchEvent(changeEvent);

                    // Special handling for React controlled components
                    const reactKey = Object.keys(targetElement).find(k => k.startsWith('__reactProps'));
                    if (reactKey) {
                        const reactHandler = targetElement[reactKey].onChange;
                        if (typeof reactHandler === 'function') {
                            reactHandler({ target: targetElement });
                        }
                    }
                }

                function searchShadowDOM(root) {
                    const allElements = root.querySelectorAll('*');
                    for (let el of allElements) {
                        if (el.shadowRoot) {
                            const result = searchShadowDOM(el.shadowRoot);
                            if (result) return result;
                        }
                        if (el.matches('textarea[aria-label*="Editor content"]')) {
                            return el;
                        }
                    }
                    return null;
                }

                function searchFrames() {
                    // Try main document first
                    let descriptionTextarea = document.querySelector('textarea[aria-label*="Editor content"]');
                    if (descriptionTextarea) return { element: descriptionTextarea, context: document };

                    // Search shadow DOM
                    const shadowElement = searchShadowDOM(document.body);
                    if (shadowElement) {
                        descriptionTextarea = shadowElement.matches('textarea') ? shadowElement : shadowElement.querySelector('textarea');
                        if (descriptionTextarea) return { element: descriptionTextarea, context: shadowElement };
                    }

                    // Check accessible iframes
                    const frames = document.querySelectorAll('iframe');
                    for (const frame of frames) {
                        try {
                            const frameDoc = frame.contentDocument || frame.contentWindow.document;
                            descriptionTextarea = frameDoc.querySelector('textarea[aria-label*="Editor content"]');
                            if (descriptionTextarea) return { element: descriptionTextarea, context: frameDoc };

                            // Search shadow DOM in iframe
                            const frameShadow = searchShadowDOM(frameDoc.body);
                            if (frameShadow) {
                                descriptionTextarea = frameShadow.matches('textarea') ? frameShadow : frameShadow.querySelector('textarea');
                                if (descriptionTextarea) return { element: descriptionTextarea, context: frameShadow };
                            }
                        } catch(e) { continue; }
                    }
                    return null;
                }

                const result = searchFrames();
                if (result) {
                    setDescriptionValue(result.element, '%DESCRIPTION%');
                    return {
                        success: true,
                        message: "description filled successfully",
                        element: result.element.tagName
                    };
                }
                return {
                    success: false,
                    message: "description textarea not found"
                };
                """.replace('%DESCRIPTION%', json.dumps(obj['description']['en'])[1:-1])

                print(f"{obj['description']['en']}")
                # Execute the full script
                result = driver.execute_script(description_js)
                if result and result['success']:
                    logging.info(f"Description input filled: {result['message']}")
                else:
                    raise Exception(f"Description input failed: {result.get('message', 'Unknown error') if result else 'No result'}")
            except Exception as e:
                logging.error(f"Description input JS error: {str(e)}")
                raise

            # --- Auth Section JS Injections ---
            # Auth Button
            try:
                auth_button_js = """
                function findAuthButtonInContext(context) {
                    const xpath = "//button[.//div[contains(translate(text(), 'AUTH', 'auth'), 'auth')]]";
                    const result = document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    const button = result.singleNodeValue;
                    if (button) {
                        console.log("Found auth button");
                        button.style.border = '3px solid #00ff00';
                        return button;
                    }
                    return null;
                }

                %SHARED_SHADOW_DOM_IFRAME_LOGIC%

                //let authButton = findAuthButtonInContext(document) || searchInShadowDOM(document.body);
                let authButton = false;

                if (!authButton) {
                    const iframes = document.querySelectorAll('iframe');
                    for (const iframe of iframes) {
                        try {
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                            authButton = findAuthButtonInContext(iframeDoc) || searchInShadowDOM(iframeDoc.body);
                            if (authButton) break;
                        } catch(e) { console.log("Iframe error:", e); }
                    }
                }

                if (authButton) {
                    authButton.click();
                    return true;
                }
                return false;
                """.replace("%SHARED_SHADOW_DOM_IFRAME_LOGIC%", SHARED_SHADOW_DOM_IFRAME_LOGIC)

                driver.execute_script(auth_button_js)
                logging.info("Auth button clicked via JS")
                human_like_delay(1, 2)

            except Exception as e:
                logging.error(f"Auth button JS error: {str(e)}")
                raise

            # Bearer Button
            try:
                bearer_button_js = """
                function findBearerButtonInContext(context) {
                    const xpath = "//button[.//div[contains(translate(text(), 'BEARER', 'bearer'), 'bearer')]]";
                    const result = document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    const button = result.singleNodeValue;
                    if (button) {
                        console.log("Found bearer button");
                        button.style.border = '3px solid #00ff00';
                        return button;
                    }
                    return null;
                }

                %SHARED_SHADOW_DOM_IFRAME_LOGIC%

                //let bearerButton = findBearerButtonInContext(document) || searchInShadowDOM(document.body);
                let bearerButton = false;

                if (!bearerButton) {
                    const iframes = document.querySelectorAll('iframe');
                    for (const iframe of iframes) {
                        try {
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                            bearerButton = findBearerButtonInContext(iframeDoc) || searchInShadowDOM(iframeDoc.body);
                            if (bearerButton) break;
                        } catch(e) { console.log("Iframe error:", e); }
                    }
                }

                if (bearerButton) {
                    bearerButton.click();
                    return true;
                }
                return false;
                """.replace("%SHARED_SHADOW_DOM_IFRAME_LOGIC%", SHARED_SHADOW_DOM_IFRAME_LOGIC)

                driver.execute_script(bearer_button_js)
                logging.info("Bearer button clicked via JS")
                human_like_delay(1, 2)

            except Exception as e:
                logging.error(f"Bearer button JS error: {str(e)}")
                raise

            # --- Token Input JS Injection ---
            try:
                token_js = """
                function setTokenValue(targetElement, value) {
                    targetElement.focus();
                    targetElement.innerHTML = '';
                    
                    // For contenteditable elements
                    const range = document.createRange();
                    const selection = window.getSelection();
                    range.selectNodeContents(targetElement);
                    range.collapse(false);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    
                    const textNode = document.createTextNode(value);
                    targetElement.appendChild(textNode);
                    
                    // Trigger necessary events
                    const inputEvent = new Event('input', { bubbles: true, cancelable: true });
                    const changeEvent = new Event('change', { bubbles: true });
                    targetElement.dispatchEvent(inputEvent);
                    targetElement.dispatchEvent(changeEvent);

                    // Handle React internal state
                    const reactKey = Object.keys(targetElement).find(k => k.startsWith('__reactProps'));
                    if (reactKey) {
                        const reactHandler = targetElement[reactKey].onChange;
                        if (typeof reactHandler === 'function') {
                            reactHandler({ target: targetElement });
                        }
                    }
                }

                function searchShadowDOM(root) {
                    const allElements = root.querySelectorAll('*');
                    for (let el of allElements) {
                        if (el.shadowRoot) {
                            const result = searchShadowDOM(el.shadowRoot);
                            if (result) return result;
                        }
                        if (el.matches('.css-sf4iut .css-kpahiq p, [data-testid="token-input"], p[contenteditable="true"]')) {
                            return el;
                        }
                    }
                    return null;
                }

                function searchFrames() {
                    // Try main document first
                    let tokenElement = document.querySelector('.css-sf4iut .css-kpahiq p, [data-testid="token-input"], p[contenteditable="true"]');
                    if (tokenElement) return { element: tokenElement, context: document };
                    
                    // Search shadow DOM
                    const shadowElement = searchShadowDOM(document.body);
                    if (shadowElement) {
                        tokenElement = shadowElement.matches('p') ? shadowElement : shadowElement.querySelector('p');
                        if (tokenElement) return { element: tokenElement, context: shadowElement };
                    }

                    // Check accessible iframes
                    const frames = document.querySelectorAll('iframe');
                    for (const frame of frames) {
                        try {
                            const frameDoc = frame.contentDocument || frame.contentWindow.document;
                            tokenElement = frameDoc.querySelector('.css-sf4iut .css-kpahiq p, [data-testid="token-input"], p[contenteditable="true"]');
                            if (tokenElement) return { element: tokenElement, context: frameDoc };
                            
                            // Search shadow DOM in iframe
                            const frameShadow = searchShadowDOM(frameDoc.body);
                            if (frameShadow) {
                                tokenElement = frameShadow.matches('p') ? frameShadow : frameShadow.querySelector('p');
                                if (tokenElement) return { element: tokenElement, context: frameShadow };
                            }
                        } catch(e) { continue; }
                    }
                    return null;
                }

                const result = searchFrames();
                if (result) {
                    setTokenValue(result.element, '%TOKEN%');
                    return {
                        success: true,
                        message: "token filled successfully",
                        elementType: result.element.tagName
                    };
                }
                return {
                    success: false,
                    message: "token input not found"
                };
                """.replace('%TOKEN%', jwt_token)

                # Execute the full script
                result = driver.execute_script(token_js)
                if result and result['success']:
                    logging.info(f"Token input filled: {result['message']}")
                else:
                    raise Exception(f"Token input failed: {result.get('message', 'Unknown error') if result else 'No result'}")
            
            except Exception as e:
                logging.error(f"Token input JS error: {str(e)}")
                raise

            # --- Sync Button JS Injection ---
            try:
                sync_js = """
                function findSyncButtonInContext(context) {
                    const button = context.querySelector('.css-1rxme48');
                    if (button) {
                        console.log("Found sync button");
                        button.style.border = '3px solid #00ff00';
                        return button;
                    }
                    return null;
                }

                %SHARED_SHADOW_DOM_IFRAME_LOGIC%

                //let syncButton = findSyncButtonInContext(document) || searchInShadowDOM(document.body);
                let syncButton = false;

                if (!syncButton) {
                    const iframes = document.querySelectorAll('iframe');
                    for (const iframe of iframes) {
                        try {
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                            syncButton = findSyncButtonInContext(iframeDoc) || searchInShadowDOM(iframeDoc.body);
                            if (syncButton) break;
                        } catch(e) { console.log("Iframe error:", e); }
                    }
                }

                if (syncButton) {
                    syncButton.click();
                    return true;
                }
                return false;
                """.replace("%SHARED_SHADOW_DOM_IFRAME_LOGIC%", SHARED_SHADOW_DOM_IFRAME_LOGIC)

                driver.execute_script(sync_js)
                logging.info("Sync button clicked via JS")
                
                # Wait for sync using Python-side check
                WebDriverWait(driver, 10).until(
                    lambda d: "sync complete" in d.page_source.lower() or 
                            "success" in d.page_source.lower()
                )
                logging.info("Sync completed successfully")

            except Exception as e:
                logging.error(f"Sync JS error: {str(e)}")
                raise

            return True
        except Exception as e:
            logging.error(f"Scraper Error: {str(e)}")
            if attempt == 2: 
                driver.save_screenshot(f"crash_{obj['slug']}.png")
                raise
            human_like_delay(5, 10)
            driver.refresh()
def main():
    parser = ArgumentParser(description='Automated API Documentation Updater')
    parser.add_argument('--mail', required=True, help='Login email')
    parser.add_argument('--password', required=True, help='Login password')
    parser.add_argument('--sftp-uri', required=True, help='SFTP connection URI')
    parser.add_argument('--token', required=True, help='JWT token for API requests')
    args = parser.parse_args()

    try:
        with SFTPManager(args.sftp_uri) as sftp:
            # Load data files
            current_data = sftp.get_json('datas_description.json')
            
            try:
                backup_data = sftp.get_json('datas_description_backup.json')
            except FileNotFoundError:
                backup_data = []
                sftp.put_json(backup_data, 'datas_description_backup.json')

            # Find new entries
            new_entries = [entry for entry in current_data if entry not in backup_data]
            if not new_entries:
                return

            # Configure browser
            options = webdriver.ChromeOptions()
            # Realistic User-Agent (Example Chrome on Windows - ADJUST)
            user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            options.add_argument(f'--user-agent={user_agent}')
            options.add_argument('--disable-blink-features=AutomationControlled') # Try to hide automation
            options.add_argument('--window-size=1920,1080')
            options.add_argument('--disable-dev-shm-usage')
            # options.add_argument('--headless=new') # Keep non-headless for debugging
            # options.add_argument('--start-maximized')
            # options.add_argument('--disable-gpu')
            # options.add_argument('--no-sandbox')
            
            with webdriver.Chrome(options=options) as driver:
                driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
                # Perform login instead of cookie injection
                perform_login(driver, args.mail, args.password)
                
                success = True
                for idx, entry in enumerate(new_entries, 1):
                    try:
                        logging.info(f"Processing {entry['slug']} ({idx}/{len(new_entries)})")
                        if not process_object(driver, entry, args.token):
                            success = False
                            break
                    except Exception as e:
                        logging.error(f"Failed processing {entry['slug']}: {str(e)}")
                        success = False
                        break

                if success:
                    updated_backup = backup_data + new_entries
                    sftp.put_json(updated_backup, 'datas_description_backup.json')
                    print("Successfully updated backup")
                else:
                    print("Aborting backup update due to failures")

    except Exception as e:
        print(f"Critical failure: {str(e)}")
        sys.exit(1)

if __name__ == '__main__':
    main()